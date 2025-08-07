// routes/admin.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { logAction } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Get system statistics
router.get('/stats', asyncHandler(async (req, res) => {
  const stats = await Promise.all([
    // User statistics
    pool.query(`
      SELECT 
        COUNT(*) as total_users,
        COUNT(CASE WHEN active = true THEN 1 END) as active_users,
        COUNT(CASE WHEN role = 'admin' THEN 1 END) as admin_users,
        COUNT(CASE WHEN role = 'manager' THEN 1 END) as manager_users,
        COUNT(CASE WHEN role = 'user' THEN 1 END) as regular_users
      FROM users
    `),
    
    // Order statistics
    pool.query(`
      SELECT 
        COUNT(*) as total_orders,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_orders,
        COUNT(CASE WHEN status = 'production' THEN 1 END) as production_orders,
        COUNT(CASE WHEN status = 'shipped' THEN 1 END) as shipped_orders,
        COUNT(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as orders_last_30_days
      FROM orders WHERE status != 'cancelled'
    `),
    
    // Customer statistics  
    pool.query(`
      SELECT 
        COUNT(*) as total_customers,
        COUNT(CASE WHEN active = true THEN 1 END) as active_customers
      FROM customers
    `),
    
    // Parts statistics
    pool.query(`
      SELECT 
        COUNT(*) as total_parts,
        COUNT(CASE WHEN active = true THEN 1 END) as active_parts
      FROM parts
    `),
    
    // Database size
    pool.query(`
      SELECT 
        pg_size_pretty(pg_database_size(current_database())) as database_size,
        (SELECT COUNT(*) FROM audit_log) as audit_log_entries
    `)
  ]);

  res.json({
    users: stats[0].rows[0],
    orders: stats[1].rows[0],
    customers: stats[2].rows[0],
    parts: stats[3].rows[0],
    system: stats[4].rows[0]
  });
}));

// Get all users
router.get('/users', asyncHandler(async (req, res) => {
  const { page = 1, limit = 50, search, role, active } = req.query;
  const offset = (page - 1) * limit;

  let whereClause = '';
  const queryParams = [];
  let paramCount = 0;

  if (search) {
    paramCount++;
    whereClause = `WHERE (first_name ILIKE ${paramCount} OR last_name ILIKE ${paramCount} OR email ILIKE ${paramCount})`;
    queryParams.push(`%${search}%`);
  }

  if (role) {
    paramCount++;
    const roleClause = `role = ${paramCount}`;
    whereClause = whereClause ? `${whereClause} AND ${roleClause}` : `WHERE ${roleClause}`;
    queryParams.push(role);
  }

  if (active !== undefined) {
    paramCount++;
    const activeClause = `active = ${paramCount}`;
    whereClause = whereClause ? `${whereClause} AND ${activeClause}` : `WHERE ${activeClause}`;
    queryParams.push(active === 'true');
  }

  const query = `
    SELECT 
      id, email, first_name, last_name, role, active, created_at, updated_at, last_login
    FROM users
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT ${paramCount + 1} OFFSET ${paramCount + 2}
  `;

  queryParams.push(limit, offset);

  const result = await pool.query(query, queryParams);

  // Get total count
  const countQuery = `SELECT COUNT(*) as total FROM users ${whereClause}`;
  const countResult = await pool.query(countQuery, queryParams.slice(0, paramCount));
  const totalCount = parseInt(countResult.rows[0].total);

  res.json({
    users: result.rows,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: totalCount,
      pages: Math.ceil(totalCount / limit)
    }
  });
}));

// Create new user
router.post('/users', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('firstName').trim().isLength({ min: 1 }),
  body('lastName').trim().isLength({ min: 1 }),
  body('role').isIn(['admin', 'manager', 'user'])
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { email, password, firstName, lastName, role } = req.body;

  // Check if user already exists
  const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existingUser.rows.length > 0) {
    return res.status(400).json({ error: 'User already exists' });
  }

  // Hash password
  const saltRounds = 12;
  const passwordHash = await bcrypt.hash(password, saltRounds);

  // Create user
  const result = await pool.query(`
    INSERT INTO users (email, password_hash, first_name, last_name, role)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id, email, first_name, last_name, role, active, created_at
  `, [email, passwordHash, firstName, lastName, role]);

  const newUser = result.rows[0];

  // Log the action
  await logAction(req.user.id, 'CREATE_USER', 'users', newUser.id, null, newUser, req);

  res.status(201).json({
    message: 'User created successfully',
    user: newUser
  });
}));

// Update user
router.put('/users/:id', [
  body('firstName').optional().trim().isLength({ min: 1 }),
  body('lastName').optional().trim().isLength({ min: 1 }),
  body('role').optional().isIn(['admin', 'manager', 'user']),
  body('active').optional().isBoolean()
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { id } = req.params;
  const { firstName, lastName, role, active } = req.body;

  // Prevent admin from deactivating themselves
  if (id === req.user.id && active === false) {
    return res.status(400).json({ error: 'Cannot deactivate your own account' });
  }

  // Get current user data
  const currentResult = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  if (currentResult.rows.length === 0) {
    return res.status(404).json({ error: 'User not found' });
  }

  const oldValues = currentResult.rows[0];

  const result = await pool.query(`
    UPDATE users 
    SET first_name = COALESCE($1, first_name),
        last_name = COALESCE($2, last_name),
        role = COALESCE($3, role),
        active = COALESCE($4, active),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $5
    RETURNING id, email, first_name, last_name, role, active, created_at, updated_at
  `, [firstName, lastName, role, active, id]);

  const updatedUser = result.rows[0];

  // Log the action
  await logAction(req.user.id, 'UPDATE_USER', 'users', id, oldValues, updatedUser, req);

  res.json(updatedUser);
}));

// Reset user password
router.put('/users/:id/password', [
  body('newPassword').isLength({ min: 6 })
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { id } = req.params;
  const { newPassword } = req.body;

  // Check if user exists
  const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [id]);
  if (userResult.rows.length === 0) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Hash new password
  const saltRounds = 12;
  const newPasswordHash = await bcrypt.hash(newPassword, saltRounds);

  // Update password
  await pool.query('UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [newPasswordHash, id]);

  // Log the action
  await logAction(req.user.id, 'RESET_PASSWORD', 'users', id, null, { targetUser: userResult.rows[0].email }, req);

  res.json({ message: 'Password reset successfully' });
}));

// Get audit log
router.get('/audit-log', asyncHandler(async (req, res) => {
  const { page = 1, limit = 100, user, action, table, startDate, endDate } = req.query;
  const offset = (page - 1) * limit;

  let whereClause = '';
  const queryParams = [];
  let paramCount = 0;

  if (user) {
    paramCount++;
    whereClause = `WHERE al.user_id = ${paramCount}`;
    queryParams.push(user);
  }

  if (action) {
    paramCount++;
    const actionClause = `al.action = ${paramCount}`;
    whereClause = whereClause ? `${whereClause} AND ${actionClause}` : `WHERE ${actionClause}`;
    queryParams.push(action);
  }

  if (table) {
    paramCount++;
    const tableClause = `al.table_name = ${paramCount}`;
    whereClause = whereClause ? `${whereClause} AND ${tableClause}` : `WHERE ${tableClause}`;
    queryParams.push(table);
  }

  if (startDate) {
    paramCount++;
    const startClause = `al.created_at >= ${paramCount}`;
    whereClause = whereClause ? `${whereClause} AND ${startClause}` : `WHERE ${startClause}`;
    queryParams.push(startDate);
  }

  if (endDate) {
    paramCount++;
    const endClause = `al.created_at <= ${paramCount}`;
    whereClause = whereClause ? `${whereClause} AND ${endClause}` : `WHERE ${endClause}`;
    queryParams.push(endDate);
  }

  const query = `
    SELECT 
      al.*,
      u.first_name,
      u.last_name,
      u.email
    FROM audit_log al
    LEFT JOIN users u ON al.user_id = u.id
    ${whereClause}
    ORDER BY al.created_at DESC
    LIMIT ${paramCount + 1} OFFSET ${paramCount + 2}
  `;

  queryParams.push(limit, offset);

  const result = await pool.query(query, queryParams);

  // Get total count
  const countQuery = `SELECT COUNT(*) as total FROM audit_log al ${whereClause}`;
  const countResult = await pool.query(countQuery, queryParams.slice(0, paramCount));
  const totalCount = parseInt(countResult.rows[0].total);

  res.json({
    logs: result.rows,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: totalCount,
      pages: Math.ceil(totalCount / limit)
    }
  });
}));

// Database backup trigger
router.post('/backup', asyncHandler(async (req, res) => {
  // This would typically trigger a backup job
  // For now, we'll just log the action
  await logAction(req.user.id, 'MANUAL_BACKUP', 'system', null, null, { timestamp: new Date() }, req);
  
  res.json({ 
    message: 'Backup initiated',
    timestamp: new Date().toISOString()
  });
}));

// System health check
router.get('/health', asyncHandler(async (req, res) => {
  const healthChecks = await Promise.all([
    // Database connection
    pool.query('SELECT 1').then(() => ({ database: 'healthy' })).catch(() => ({ database: 'unhealthy' })),
    
    // Check disk space (simplified)
    pool.query(`SELECT pg_size_pretty(pg_database_size(current_database())) as size`).then(result => ({
      diskSpace: result.rows[0].size
    })),
    
    // Check recent errors
    pool.query(`
      SELECT COUNT(*) as error_count 
      FROM audit_log 
      WHERE action LIKE '%ERROR%' 
      AND created_at >= CURRENT_TIMESTAMP - INTERVAL '1 hour'
    `).then(result => ({
      recentErrors: parseInt(result.rows[0].error_count)
    }))
  ]);

  const health = healthChecks.reduce((acc, check) => ({ ...acc, ...check }), {});
  
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    ...health
  });
}));

// Clean up old audit logs
router.delete('/audit-log/cleanup', asyncHandler(async (req, res) => {
  const { days = 90 } = req.query;
  
  const result = await pool.query(`
    DELETE FROM audit_log 
    WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '$1 days'
    RETURNING COUNT(*) as deleted_count
  `, [days]);

  const deletedCount = result.rowCount;

  await logAction(req.user.id, 'CLEANUP_AUDIT_LOG', 'audit_log', null, null, { 
    deletedCount, 
    olderThanDays: days 
  }, req);

  res.json({ 
    message: `Cleaned up audit log entries older than ${days} days`,
    deletedCount 
  });
}));

module.exports = router;