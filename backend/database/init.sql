-- Order Management System Database Schema

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    role VARCHAR(50) NOT NULL CHECK (role IN ('admin', 'manager', 'user')),
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP WITH TIME ZONE
);

-- Customers table
CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    contact_person VARCHAR(255),
    email VARCHAR(255),
    phone VARCHAR(50),
    address TEXT,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_by UUID REFERENCES users(id)
);

-- Parts table
CREATE TABLE parts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    part_number VARCHAR(100) UNIQUE NOT NULL,
    description TEXT NOT NULL,
    colors TEXT,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_by UUID REFERENCES users(id)
);

-- Orders table
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    po_number VARCHAR(100) NOT NULL,
    customer_id UUID NOT NULL REFERENCES customers(id),
    due_date DATE,
    quoted_ship_date DATE,
    status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'production', 'shipped', 'cancelled')),
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_by UUID REFERENCES users(id),
    UNIQUE(customer_id, po_number)
);

-- Order line items table
CREATE TABLE order_line_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    part_id UUID REFERENCES parts(id),
    part_number VARCHAR(100) NOT NULL,
    description TEXT NOT NULL,
    colors VARCHAR(255),
    quantity DECIMAL(10,2) NOT NULL CHECK (quantity > 0),
    unit VARCHAR(20) NOT NULL CHECK (unit IN ('feet', 'meters', 'pieces')),
    in_production BOOLEAN DEFAULT false,
    shipped_quantity DECIMAL(10,2) DEFAULT 0 CHECK (shipped_quantity >= 0),
    date_shipped DATE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Shipments table (for tracking partial shipments)
CREATE TABLE shipments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    line_item_id UUID NOT NULL REFERENCES order_line_items(id),
    quantity DECIMAL(10,2) NOT NULL CHECK (quantity > 0),
    ship_date DATE NOT NULL,
    tracking_number VARCHAR(100),
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_by UUID REFERENCES users(id)
);

-- Audit log table
CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    action VARCHAR(100) NOT NULL,
    table_name VARCHAR(50) NOT NULL,
    record_id UUID,
    old_values JSONB,
    new_values JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX idx_orders_customer_id ON orders(customer_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at);
CREATE INDEX idx_line_items_order_id ON order_line_items(order_id);
CREATE INDEX idx_line_items_part_id ON order_line_items(part_id);
CREATE INDEX idx_shipments_line_item_id ON shipments(line_item_id);
CREATE INDEX idx_audit_log_user_id ON audit_log(user_id);
CREATE INDEX idx_audit_log_created_at ON audit_log(created_at);
CREATE INDEX idx_customers_name ON customers(name);
CREATE INDEX idx_parts_part_number ON parts(part_number);

-- Create triggers for updating updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_customers_updated_at BEFORE UPDATE ON customers 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_parts_updated_at BEFORE UPDATE ON parts 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_line_items_updated_at BEFORE UPDATE ON order_line_items 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to automatically update order status based on line items
CREATE OR REPLACE FUNCTION update_order_status()
RETURNS TRIGGER AS $$
DECLARE
    order_record RECORD;
    total_items INTEGER;
    shipped_items INTEGER;
    production_items INTEGER;
BEGIN
    -- Get the order associated with this line item
    SELECT INTO order_record * FROM orders WHERE id = COALESCE(NEW.order_id, OLD.order_id);
    
    -- Count line items by status
    SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN date_shipped IS NOT NULL THEN 1 END) as shipped,
        COUNT(CASE WHEN in_production = true AND date_shipped IS NULL THEN 1 END) as in_prod
    INTO total_items, shipped_items, production_items
    FROM order_line_items 
    WHERE order_id = order_record.id;
    
    -- Update order status based on line item statuses
    IF shipped_items = total_items THEN
        UPDATE orders SET status = 'shipped' WHERE id = order_record.id;
    ELSIF production_items > 0 OR shipped_items > 0 THEN
        UPDATE orders SET status = 'production' WHERE id = order_record.id;
    ELSE
        UPDATE orders SET status = 'pending' WHERE id = order_record.id;
    END IF;
    
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_order_status 
    AFTER INSERT OR UPDATE OR DELETE ON order_line_items
    FOR EACH ROW EXECUTE FUNCTION update_order_status();

-- Insert default admin user (password: admin123)
INSERT INTO users (email, password_hash, first_name, last_name, role) 
VALUES (
    'admin@company.com', 
    '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', -- bcrypt hash for 'admin123'
    'System', 
    'Administrator', 
    'admin'
);

-- Insert sample data for testing
INSERT INTO customers (name, contact_person, email, phone, address) VALUES
('ABC Manufacturing', 'John Smith', 'john@abc.com', '555-0101', '123 Industrial Ave, Boston, MA'),
('XYZ Corporation', 'Jane Doe', 'jane@xyz.com', '555-0102', '456 Business St, Cambridge, MA'),
('Tech Solutions Inc', 'Bob Johnson', 'bob@tech.com', '555-0103', '789 Technology Blvd, Somerville, MA');

INSERT INTO parts (part_number, description, colors) VALUES
('WG-001', 'Wire Guard Standard', 'Black, White, Gray'),
('CB-100', 'Cable Bundle 100mm', 'Black, Red, Blue'),
('MT-200', 'Mounting Bracket 200', 'Silver, Black'),
('SP-050', 'Support Post 50cm', 'Galvanized, Black');

-- Sample order with line items
INSERT INTO orders (po_number, customer_id, due_date, quoted_ship_date, status, created_by)
SELECT 'PO-2024-001', c.id, '2024-09-15', '2024-09-10', 'pending', u.id
FROM customers c, users u 
WHERE c.name = 'ABC Manufacturing' AND u.email = 'admin@company.com';

INSERT INTO order_line_items (order_id, part_id, part_number, description, colors, quantity, unit)
SELECT o.id, p.id, p.part_number, p.description, 'Black', 100, 'pieces'
FROM orders o, parts p 
WHERE o.po_number = 'PO-2024-001' AND p.part_number = 'WG-001';

-- Create views for common queries
CREATE VIEW order_summary AS
SELECT 
    o.id,
    o.po_number,
    c.name as customer_name,
    o.due_date,
    o.quoted_ship_date,
    o.status,
    COUNT(oli.id) as total_line_items,
    COUNT(CASE WHEN oli.date_shipped IS NOT NULL THEN 1 END) as shipped_items,
    SUM(oli.quantity) as total_quantity,
    SUM(oli.shipped_quantity) as total_shipped_quantity,
    o.created_at,
    o.updated_at
FROM orders o
JOIN customers c ON o.customer_id = c.id
LEFT JOIN order_line_items oli ON o.id = oli.order_id
WHERE o.status != 'cancelled'
GROUP BY o.id, c.name;

CREATE VIEW customer_stats AS
SELECT 
    c.id,
    c.name,
    COUNT(o.id) as total_orders,
    COUNT(CASE WHEN o.status = 'pending' THEN 1 END) as pending_orders,
    COUNT(CASE WHEN o.status = 'production' THEN 1 END) as production_orders,
    COUNT(CASE WHEN o.status = 'shipped' THEN 1 END) as shipped_orders,
    c.created_at,
    c.updated_at
FROM customers c
LEFT JOIN orders o ON c.id = o.customer_id
WHERE c.active = true
GROUP BY c.id;