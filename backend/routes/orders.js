// routes/orders.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const { Pool } = require('pg');
const { requireRole, logAction } = require('../middleware/auth');

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Get all orders with pagination and filtering
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 50, customer, status, search } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE o.status != \'cancelled\'';
    const queryParams = [];
    let paramCount = 0;

    if (customer) {
      paramCount++;
      whereClause += ` AND c.id = $${paramCount}`;
      queryParams.push(customer);
    }

    if (status) {
      paramCount++;
      whereClause += ` AND o.status = $${paramCount}`;
      queryParams.push(status);
    }

    if (search) {
      paramCount++;
      whereClause += ` AND (o.po_number ILIKE $${paramCount} OR c.name ILIKE $${paramCount})`;
      queryParams.push(`%${search}%`);
    }

    const query = `
      SELECT 
        o.id,
        o.po_number,
        c.id as customer_id,
        c.name as customer_name,
        o.due_date,
        o.quoted_ship_date,
        o.status,
        o.notes,
        o.created_at,
        o.updated_at,
        COUNT(oli.id) as total_line_items,
        COUNT(CASE WHEN oli.date_shipped IS NOT NULL THEN 1 END) as shipped_items,
        SUM(oli.quantity) as total_quantity,
        SUM(oli.shipped_quantity) as total_shipped_quantity
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      LEFT JOIN order_line_items oli ON o.id = oli.order_id
      ${whereClause}
      GROUP BY o.id, c.id, c.name
      ORDER BY o.created_at DESC
      LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
    `;

    queryParams.push(limit, offset);

    const result = await pool.query(query, queryParams);

    // Get total count for pagination
    const countQuery = `
      SELECT COUNT(DISTINCT o.id) as total
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      ${whereClause}
    `;

    const countResult = await pool.query(countQuery, queryParams.slice(0, paramCount));
    const totalCount = parseInt(countResult.rows[0].total);

    res.json({
      orders: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalCount,
        pages: Math.ceil(totalCount / limit)
      }
    });

  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single order with line items
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Get order details
    const orderQuery = `
      SELECT 
        o.id,
        o.po_number,
        c.id as customer_id,
        c.name as customer_name,
        c.contact_person,
        c.email as customer_email,
        c.phone as customer_phone,
        c.address as customer_address,
        o.due_date,
        o.quoted_ship_date,
        o.status,
        o.notes,
        o.created_at,
        o.updated_at
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.id = $1
    `;

    const orderResult = await pool.query(orderQuery, [id]);

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];

    // Get line items
    const lineItemsQuery = `
      SELECT 
        oli.id,
        oli.part_id,
        p.part_number as part_part_number,
        oli.part_number,
        oli.description,
        oli.colors,
        oli.quantity,
        oli.unit,
        oli.in_production,
        oli.shipped_quantity,
        oli.date_shipped,
        oli.created_at,
        oli.updated_at
      FROM order_line_items oli
      LEFT JOIN parts p ON oli.part_id = p.id
      WHERE oli.order_id = $1
      ORDER BY oli.created_at
    `;

    const lineItemsResult = await pool.query(lineItemsQuery, [id]);

    // Get shipments for each line item
    const shipmentsQuery = `
      SELECT 
        s.id,
        s.line_item_id,
        s.quantity,
        s.ship_date,
        s.tracking_number,
        s.notes,
        s.created_at,
        u.first_name,
        u.last_name
      FROM shipments s
      LEFT JOIN users u ON s.created_by = u.id
      WHERE s.line_item_id = ANY($1)
      ORDER BY s.ship_date DESC
    `;

    const lineItemIds = lineItemsResult.rows.map(item => item.id);
    let shipments = [];
    
    if (lineItemIds.length > 0) {
      const shipmentsResult = await pool.query(shipmentsQuery, [lineItemIds]);
      shipments = shipmentsResult.rows;
    }

    // Group shipments by line item
    const lineItemsWithShipments = lineItemsResult.rows.map(item => ({
      ...item,
      shipments: shipments.filter(s => s.line_item_id === item.id)
    }));

    res.json({
      ...order,
      lineItems: lineItemsWithShipments
    });

  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create new order
router.post('/', [
  body('poNumber').trim().notEmpty(),
  body('customerId').isUUID(),
  body('dueDate').optional().isISO8601(),
  body('quotedShipDate').optional().isISO8601(),
  body('lineItems').isArray({ min: 1 }),
  body('lineItems.*.partNumber').trim().notEmpty(),
  body('lineItems.*.description').trim().notEmpty(),
  body('lineItems.*.quantity').isFloat({ min: 0.01 }),
  body('lineItems.*.unit').isIn(['feet', 'meters', 'pieces'])
], requireRole(['admin', 'manager']), async (req, res) => {
  const client = await pool.connect();
  
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    await client.query('BEGIN');

    const { poNumber, customerId, dueDate, quotedShipDate, notes, lineItems } = req.body;

    // Check if PO number already exists for this customer
    const existingOrder = await client.query(
      'SELECT id FROM orders WHERE customer_id = $1 AND po_number = $2',
      [customerId, poNumber]
    );

    if (existingOrder.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'PO number already exists for this customer' });
    }

    // Verify customer exists
    const customerCheck = await client.query('SELECT id FROM customers WHERE id = $1 AND active = true', [customerId]);
    if (customerCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Customer not found' });
    }

    // Create order
    const orderResult = await client.query(`
      INSERT INTO orders (po_number, customer_id, due_date, quoted_ship_date, notes, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, po_number, customer_id, due_date, quoted_ship_date, status, notes, created_at
    `, [poNumber, customerId, dueDate || null, quotedShipDate || null, notes || null, req.user.id]);

    const order = orderResult.rows[0];

    // Create line items
    const createdLineItems = [];
    for (const item of lineItems) {
      const lineItemResult = await client.query(`
        INSERT INTO order_line_items (order_id, part_id, part_number, description, colors, quantity, unit)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `, [
        order.id,
        item.partId || null,
        item.partNumber,
        item.description,
        item.colors || null,
        item.quantity,
        item.unit
      ]);
      
      createdLineItems.push(lineItemResult.rows[0]);
    }

    await client.query('COMMIT');

    // Log the action
    await logAction(req.user.id, 'CREATE_ORDER', 'orders', order.id, null, order, req);

    res.status(201).json({
      ...order,
      lineItems: createdLineItems
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create order error:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Update order
router.put('/:id', [
  body('poNumber').optional().trim().notEmpty(),
  body('dueDate').optional().isISO8601(),
  body('quotedShipDate').optional().isISO8601()
], requireRole(['admin', 'manager']), async (req, res) => {
  try {
    const { id } = req.params;
    const { poNumber, dueDate, quotedShipDate, notes } = req.body;

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    // Get current order data for audit log
    const currentOrder = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (currentOrder.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const oldValues = currentOrder.rows[0];

    // Update order
    const result = await pool.query(`
      UPDATE orders 
      SET po_number = COALESCE($1, po_number),
          due_date = COALESCE($2, due_date),
          quoted_ship_date = COALESCE($3, quoted_ship_date),
          notes = COALESCE($4, notes),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $5
      RETURNING *
    `, [poNumber, dueDate, quotedShipDate, notes, id]);

    const updatedOrder = result.rows[0];

    // Log the action
    await logAction(req.user.id, 'UPDATE_ORDER', 'orders', id, oldValues, updatedOrder, req);

    res.json(updatedOrder);

  } catch (error) {
    console.error('Update order error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Set line item to production
router.put('/:orderId/items/:itemId/production', requireRole(['admin', 'manager']), async (req, res) => {
  try {
    const { orderId, itemId } = req.params;

    // Verify line item belongs to order
    const lineItem = await pool.query(
      'SELECT * FROM order_line_items WHERE id = $1 AND order_id = $2',
      [itemId, orderId]
    );

    if (lineItem.rows.length === 0) {
      return res.status(404).json({ error: 'Line item not found' });
    }

    const oldValues = lineItem.rows[0];

    // Update to production
    const result = await pool.query(`
      UPDATE order_line_items 
      SET in_production = true, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `, [itemId]);

    const updatedItem = result.rows[0];

    // Log the action
    await logAction(req.user.id, 'SET_PRODUCTION', 'order_line_items', itemId, oldValues, updatedItem, req);

    res.json(updatedItem);

  } catch (error) {
    console.error('Set production error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Ship line item (partial or full)
router.post('/:orderId/items/:itemId/ship', [
  body('quantity').isFloat({ min: 0.01 }),
  body('shipDate').optional().isISO8601(),
  body('trackingNumber').optional().trim(),
  body('notes').optional().trim()
], requireRole(['admin', 'manager']), async (req, res) => {
  const client = await pool.connect();
  
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    await client.query('BEGIN');

    const { orderId, itemId } = req.params;
    const { quantity, shipDate, trackingNumber, notes } = req.body;

    // Get line item
    const lineItemResult = await client.query(
      'SELECT * FROM order_line_items WHERE id = $1 AND order_id = $2',
      [itemId, orderId]
    );

    if (lineItemResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Line item not found' });
    }

    const lineItem = lineItemResult.rows[0];
    const remainingQuantity = lineItem.quantity - lineItem.shipped_quantity;

    if (quantity > remainingQuantity) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Quantity exceeds remaining amount' });
    }

    // Create shipment record
    await client.query(`
      INSERT INTO shipments (line_item_id, quantity, ship_date, tracking_number, notes, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [itemId, quantity, shipDate || new Date().toISOString().split('T')[0], trackingNumber, notes, req.user.id]);

    // Update line item
    const newShippedQuantity = lineItem.shipped_quantity + quantity;
    const isFullyShipped = newShippedQuantity >= lineItem.quantity;

    const updatedLineItem = await client.query(`
      UPDATE order_line_items 
      SET shipped_quantity = $1,
          date_shipped = CASE WHEN $2 THEN $3 ELSE date_shipped END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING *
    `, [newShippedQuantity, isFullyShipped, shipDate || new Date().toISOString().split('T')[0], itemId]);

    await client.query('COMMIT');

    // Log the action
    await logAction(req.user.id, 'SHIP_ITEM', 'order_line_items', itemId, lineItem, updatedLineItem.rows[0], req);

    res.json({
      message: 'Item shipped successfully',
      lineItem: updatedLineItem.rows[0],
      shippedQuantity: quantity,
      remainingQuantity: lineItem.quantity - newShippedQuantity
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Ship item error:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Delete order (admin only)
router.delete('/:id', requireRole(['admin']), async (req, res) => {
  try {
    const { id } = req.params;

    // Get order for audit log
    const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];

    // Soft delete by marking as cancelled
    await pool.query('UPDATE orders SET status = \'cancelled\', updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);

    // Log the action
    await logAction(req.user.id, 'DELETE_ORDER', 'orders', id, order, null, req);

    res.json({ message: 'Order cancelled successfully' });

  } catch (error) {
    console.error('Delete order error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get dashboard statistics
router.get('/stats/dashboard', async (req, res) => {
  try {
    const statsQuery = `
      SELECT 
        COUNT(*) as total_orders,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_orders,
        COUNT(CASE WHEN status = 'production' THEN 1 END) as production_orders,
        COUNT(CASE WHEN status = 'shipped' AND DATE_TRUNC('month', updated_at) = DATE_TRUNC('month', CURRENT_DATE) THEN 1 END) as shipped_this_month
      FROM orders
      WHERE status != 'cancelled'
    `;

    const result = await pool.query(statsQuery);
    
    res.json(result.rows[0]);

  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;