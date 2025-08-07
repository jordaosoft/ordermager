// routes/parts.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const { Pool } = require('pg');
const { requireRole, logAction } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Get all parts with pagination and search
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
    const searchClause = `(part_number ILIKE $${paramCount} OR description ILIKE $${paramCount})`;
    whereClause = whereClause ? `${whereClause} AND ${searchClause}` : `WHERE ${searchClause}`;
    queryParams.push(`%${search}%`);
  }

  const query = `
    SELECT 
      p.*,
      COUNT(oli.id) as usage_count,
      MAX(oli.created_at) as last_used
    FROM parts p
    LEFT JOIN order_line_items oli ON p.id = oli.part_id
    ${whereClause}
    GROUP BY p.id
    ORDER BY p.part_number
    LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
  `;

  queryParams.push(limit, offset);

  const result = await pool.query(query, queryParams);

  // Get total count
  const countQuery = `SELECT COUNT(*) as total FROM parts p ${whereClause}`;
  const countResult = await pool.query(countQuery, queryParams.slice(0, paramCount));
  const totalCount = parseInt(countResult.rows[0].total);

  res.json({
    parts: result.rows,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: totalCount,
      pages: Math.ceil(totalCount / limit)
    }
  });
}));

// Get single part with usage statistics
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const partQuery = `
    SELECT 
      p.*,
      COUNT(oli.id) as usage_count,
      MAX(oli.created_at) as last_used,
      SUM(oli.quantity) as total_quantity_ordered
    FROM parts p
    LEFT JOIN order_line_items oli ON p.id = oli.part_id
    WHERE p.id = $1
    GROUP BY p.id
  `;

  const result = await pool.query(partQuery, [id]);

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Part not found' });
  }

  // Get recent orders using this part
  const ordersQuery = `
    SELECT DISTINCT
      o.id,
      o.po_number,
      c.name as customer_name,
      o.status,
      oli.quantity,
      oli.colors,
      o.created_at
    FROM order_line_items oli
    JOIN orders o ON oli.order_id = o.id
    JOIN customers c ON o.customer_id = c.id
    WHERE oli.part_id = $1
    ORDER BY o.created_at DESC
    LIMIT 10
  `;

  const ordersResult = await pool.query(ordersQuery, [id]);

  res.json({
    ...result.rows[0],
    recentOrders: ordersResult.rows
  });
}));

// Create new part
router.post('/', [
  body('partNumber').trim().isLength({ min: 1 }).withMessage('Part number is required'),
  body('description').trim().isLength({ min: 1 }).withMessage('Description is required'),
  body('colors').optional().trim()
], requireRole(['admin', 'manager']), asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { partNumber, description, colors } = req.body;

  // Check for duplicate part number
  const existing = await pool.query('SELECT id FROM parts WHERE LOWER(part_number) = LOWER($1)', [partNumber]);
  if (existing.rows.length > 0) {
    return res.status(400).json({ error: 'Part number already exists' });
  }

  const result = await pool.query(`
    INSERT INTO parts (part_number, description, colors, created_by)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `, [partNumber, description, colors || null, req.user.id]);

  const part = result.rows[0];

  // Log the action
  await logAction(req.user.id, 'CREATE_PART', 'parts', part.id, null, part, req);

  res.status(201).json(part);
}));

// Update part
router.put('/:id', [
  body('partNumber').optional().trim().isLength({ min: 1 }),
  body('description').optional().trim().isLength({ min: 1 }),
  body('colors').optional().trim()
], requireRole(['admin', 'manager']), asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { id } = req.params;
  const { partNumber, description, colors } = req.body;

  // Get current part data
  const currentResult = await pool.query('SELECT * FROM parts WHERE id = $1', [id]);
  if (currentResult.rows.length === 0) {
    return res.status(404).json({ error: 'Part not found' });
  }

  const oldValues = currentResult.rows[0];

  // Check for duplicate part number if part number is being changed
  if (partNumber && partNumber.toLowerCase() !== oldValues.part_number.toLowerCase()) {
    const existing = await pool.query('SELECT id FROM parts WHERE LOWER(part_number) = LOWER($1) AND id != $2', [partNumber, id]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Part number already exists' });
    }
  }

  const result = await pool.query(`
    UPDATE parts 
    SET part_number = COALESCE($1, part_number),
        description = COALESCE($2, description),
        colors = COALESCE($3, colors),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $4
    RETURNING *
  `, [partNumber, description, colors, id]);

  const updatedPart = result.rows[0];

  // Log the action
  await logAction(req.user.id, 'UPDATE_PART', 'parts', id, oldValues, updatedPart, req);

  res.json(updatedPart);
}));

// Deactivate part (soft delete)
router.delete('/:id', requireRole(['admin']), asyncHandler(async (req, res) => {
  const { id } = req.params;

  // Check if part is used in active orders
  const activeOrders = await pool.query(`
    SELECT COUNT(*) as count 
    FROM order_line_items oli
    JOIN orders o ON oli.order_id = o.id
    WHERE oli.part_id = $1 AND o.status IN ('pending', 'production')
  `, [id]);

  if (parseInt(activeOrders.rows[0].count) > 0) {
    return res.status(400).json({ 
      error: 'Cannot deactivate part that is used in active orders' 
    });
  }

  // Get part data for logging
  const partResult = await pool.query('SELECT * FROM parts WHERE id = $1', [id]);
  if (partResult.rows.length === 0) {
    return res.status(404).json({ error: 'Part not found' });
  }

  const part = partResult.rows[0];

  // Deactivate part
  await pool.query('UPDATE parts SET active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);

  // Log the action
  await logAction(req.user.id, 'DEACTIVATE_PART', 'parts', id, part, null, req);

  res.json({ message: 'Part deactivated successfully' });
}));

// Reactivate part
router.put('/:id/activate', requireRole(['admin']), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const result = await pool.query(`
    UPDATE parts 
    SET active = true, updated_at = CURRENT_TIMESTAMP 
    WHERE id = $1
    RETURNING *
  `, [id]);

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Part not found' });
  }

  const part = result.rows[0];

  // Log the action
  await logAction(req.user.id, 'ACTIVATE_PART', 'parts', id, null, part, req);

  res.json(part);
}));

// Search parts (for autocomplete in order creation)
router.get('/search/:query', asyncHandler(async (req, res) => {
  const { query } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);

  const result = await pool.query(`
    SELECT id, part_number, description, colors
    FROM parts
    WHERE active = true 
    AND (part_number ILIKE $1 OR description ILIKE $1)
    ORDER BY 
      CASE WHEN part_number ILIKE $2 THEN 1 ELSE 2 END,
      part_number
    LIMIT $3
  `, [`%${query}%`, `${query}%`, limit]);

  res.json(result.rows);
}));

module.exports = router;