// routes/customers.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const { Pool } = require('pg');
const { requireRole, logAction } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Get all customers with pagination and search
router.get('/', asyncHandler(async (req, res) => {
  const { page = 1, limit = 50, search, active = 'true' } = req.query;
  const offset = (page - 1) * limit;

  let whereClause = '';
  const queryParams = [];
  let paramCount = 0;

  if (active === 'true') {
    paramCount++;
    whereClause = `WHERE active = $${paramCount}`;
    queryParams.push(true);
  }

  if (search) {
    paramCount++;
    const searchClause = `(name ILIKE $${paramCount} OR contact_person ILIKE $${paramCount} OR email ILIKE $${paramCount})`;
    whereClause = whereClause ? `${whereClause} AND ${searchClause}` : `WHERE ${searchClause}`;
    queryParams.push(`%${search}%`);
  }

  const query = `
    SELECT 
      c.*,
      COUNT(o.id) as total_orders,
      COUNT(CASE WHEN o.status = 'pending' THEN 1 END) as pending_orders,
      COUNT(CASE WHEN o.status = 'production' THEN 1 END) as production_orders,
      COUNT(CASE WHEN o.status = 'shipped' THEN 1 END) as shipped_orders
    FROM customers c
    LEFT JOIN orders o ON c.id = o.customer_id AND o.status != 'cancelled'
    ${whereClause}
    GROUP BY c.id
    ORDER BY c.name
    LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
  `;

  queryParams.push(limit, offset);

  const result = await pool.query(query, queryParams);

  // Get total count
  const countQuery = `SELECT COUNT(*) as total FROM customers c ${whereClause}`;
  const countResult = await pool.query(countQuery, queryParams.slice(0, paramCount));
  const totalCount = parseInt(countResult.rows[0].total);

  res.json({
    customers: result.rows,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: totalCount,
      pages: Math.ceil(totalCount / limit)
    }
  });
}));

// Get single customer with order statistics
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const customerQuery = `
    SELECT 
      c.*,
      COUNT(o.id) as total_orders,
      COUNT(CASE WHEN o.status = 'pending' THEN 1 END) as pending_orders,
      COUNT(CASE WHEN o.status = 'production' THEN 1 END) as production_orders,
      COUNT(CASE WHEN o.status = 'shipped' THEN 1 END) as shipped_orders
    FROM customers c
    LEFT JOIN orders o ON c.id = o.customer_id AND o.status != 'cancelled'
    WHERE c.id = $1
    GROUP BY c.id
  `;

  const result = await pool.query(customerQuery, [id]);

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  // Get recent orders
  const ordersQuery = `
    SELECT id, po_number, status, due_date, created_at
    FROM orders
    WHERE customer_id = $1 AND status != 'cancelled'
    ORDER BY created_at DESC
    LIMIT 10
  `;

  const ordersResult = await pool.query(ordersQuery, [id]);

  res.json({
    ...result.rows[0],
    recentOrders: ordersResult.rows
  });
}));

// Create new customer
router.post('/', [
  body('name').trim().isLength({ min: 1 }).withMessage('Name is required'),
  body('contactPerson').optional().trim(),
  body('email').optional().isEmail().normalizeEmail(),
  body('phone').optional().trim(),
  body('address').optional().trim()
], requireRole(['admin', 'manager']), asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { name, contactPerson, email, phone, address } = req.body;

  // Check for duplicate name
  const existing = await pool.query('SELECT id FROM customers WHERE LOWER(name) = LOWER($1)', [name]);
  if (existing.rows.length > 0) {
    return res.status(400).json({ error: 'Customer with this name already exists' });
  }

  const result = await pool.query(`
    INSERT INTO customers (name, contact_person, email, phone, address, created_by)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `, [name, contactPerson || null, email || null, phone || null, address || null, req.user.id]);

  const customer = result.rows[0];

  // Log the action
  await logAction(req.user.id, 'CREATE_CUSTOMER', 'customers', customer.id, null, customer, req);

  res.status(201).json(customer);
}));

// Update customer
router.put('/:id', [
  body('name').optional().trim().isLength({ min: 1 }),
  body('contactPerson').optional().trim(),
  body('email').optional().isEmail().normalizeEmail(),
  body('phone').optional().trim(),
  body('address').optional().trim()
], requireRole(['admin', 'manager']), asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { id } = req.params;
  const { name, contactPerson, email, phone, address } = req.body;

  // Get current customer data
  const currentResult = await pool.query('SELECT * FROM customers WHERE id = $1', [id]);
  if (currentResult.rows.length === 0) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  const oldValues = currentResult.rows[0];

  // Check for duplicate name if name is being changed
  if (name && name.toLowerCase() !== oldValues.name.toLowerCase()) {
    const existing = await pool.query('SELECT id FROM customers WHERE LOWER(name) = LOWER($1) AND id != $2', [name, id]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Customer with this name already exists' });
    }
  }

  const result = await pool.query(`
    UPDATE customers 
    SET name = COALESCE($1, name),
        contact_person = COALESCE($2, contact_person),
        email = COALESCE($3, email),
        phone = COALESCE($4, phone),
        address = COALESCE($5, address),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $6
    RETURNING *
  `, [name, contactPerson, email, phone, address, id]);

  const updatedCustomer = result.rows[0];

  // Log the action
  await logAction(req.user.id, 'UPDATE_CUSTOMER', 'customers', id, oldValues, updatedCustomer, req);

  res.json(updatedCustomer);
}));

// Deactivate customer (soft delete)
router.delete('/:id', requireRole(['admin']), asyncHandler(async (req, res) => {
  const { id } = req.params;

  // Check if customer has active orders
  const activeOrders = await pool.query(
    'SELECT COUNT(*) as count FROM orders WHERE customer_id = $1 AND status IN (\'pending\', \'production\')',
    [id]
  );

  if (parseInt(activeOrders.rows[0].count) > 0) {
    return res.status(400).json({ 
      error: 'Cannot deactivate customer with active orders' 
    });
  }

  // Get customer data for logging
  const customerResult = await pool.query('SELECT * FROM customers WHERE id = $1', [id]);
  if (customerResult.rows.length === 0) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  const customer = customerResult.rows[0];

  // Deactivate customer
  await pool.query('UPDATE customers SET active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);

  // Log the action
  await logAction(req.user.id, 'DEACTIVATE_CUSTOMER', 'customers', id, customer, null, req);

  res.json({ message: 'Customer deactivated successfully' });
}));

// Reactivate customer
router.put('/:id/activate', requireRole(['admin']), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const result = await pool.query(`
    UPDATE customers 
    SET active = true, updated_at = CURRENT_TIMESTAMP 
    WHERE id = $1
    RETURNING *
  `, [id]);

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  const customer = result.rows[0];

  // Log the action
  await logAction(req.user.id, 'ACTIVATE_CUSTOMER', 'customers', id, null, customer, req);

  res.json(customer);
}));

module.exports = router;