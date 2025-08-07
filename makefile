# Order Management System - Production Deployment Makefile

.PHONY: help install start stop restart logs clean backup restore update health

# Default target
help:
	@echo "Order Management System - Available Commands:"
	@echo ""
	@echo "  install     - Initial setup and configuration"
	@echo "  start       - Start all services"
	@echo "  stop        - Stop all services"
	@echo "  restart     - Restart all services"
	@echo "  logs        - Show application logs"
	@echo "  health      - Check system health"
	@echo "  backup      - Create manual backup"
	@echo "  restore     - Restore from backup"
	@echo "  update      - Update and redeploy"
	@echo "  clean       - Clean unused Docker resources"
	@echo ""

# Initial installation
install:
	@echo "🚀 Installing Order Management System..."
	@if [ ! -f .env ]; then \
		echo "📝 Creating .env file from template..."; \
		cp .env.example .env; \
		echo "⚠️  Please edit .env file with your configuration!"; \
		echo "⚠️  Pay special attention to passwords and secrets!"; \
	fi
	@echo "🐳 Building Docker containers..."
	docker-compose build
	@echo "🔧 Creating required directories..."
	mkdir -p logs uploads backups ssl
	@echo "🔒 Generating SSL certificates..."
	@if [ ! -f ssl/nginx.crt ]; then \
		openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
			-keyout ssl/nginx.key \
			-out ssl/nginx.crt \
			-subj "/C=US/ST=State/L=City/O=Company/CN=localhost"; \
	fi
	@echo "✅ Installation complete!"
	@echo "💡 Next steps:"
	@echo "   1. Edit .env file with your settings"
	@echo "   2. Run 'make start' to launch the system"
	@echo "   3. Access at https://localhost"

# Start all services
start:
	@echo "🚀 Starting Order Management System..."
	docker-compose up -d
	@echo "⏳ Waiting for services to be ready..."
	@sleep 10
	@$(MAKE) health
	@echo "✅ System is running!"
	@echo "🌐 Frontend: https://localhost"
	@echo "🔧 API: https://localhost/api"
	@echo "📊 Default login: admin@company.com / admin123"

# Stop all services
stop:
	@echo "🛑 Stopping Order Management System..."
	docker-compose down
	@echo "✅ System stopped!"

# Restart all services
restart: stop start

# Show logs
logs:
	@echo "📋 Application Logs (Press Ctrl+C to exit):"
	docker-compose logs -f

# Health check
health:
	@echo "🏥 Checking system health..."
	@echo -n "Database: "
	@if docker-compose exec -T postgres pg_isready -U postgres >/dev/null 2>&1; then \
		echo "✅ Healthy"; \
	else \
		echo "❌ Not responding"; \
	fi
	@echo -n "Redis: "
	@if docker-compose exec -T redis redis-cli ping >/dev/null 2>&1; then \
		echo "✅ Healthy"; \
	else \
		echo "❌ Not responding"; \
	fi
	@echo -n "Backend API: "
	@if curl -k -s https://localhost/health >/dev/null 2>&1; then \
		echo "✅ Healthy"; \
	else \
		echo "❌ Not responding"; \
	fi
	@echo -n "Frontend: "
	@if curl -k -s https://localhost >/dev/null 2>&1; then \
		echo "✅ Healthy"; \
	else \
		echo "❌ Not responding"; \
	fi

# Create manual backup
backup:
	@echo "💾 Creating backup..."
	@TIMESTAMP=$$(date +%Y%m%d_%H%M%S) && \
	mkdir -p backups/$$TIMESTAMP && \
	echo "📤 Backing up database..." && \
	docker-compose exec -T postgres pg_dump -U postgres order_management > backups/$$TIMESTAMP/database.sql && \
	echo "📤 Backing up uploads..." && \
	cp -r uploads backups/$$TIMESTAMP/ 2>/dev/null || true && \
	echo "📤 Backing up configuration..." && \
	cp .env backups/$$TIMESTAMP/ && \
	echo "📦 Creating archive..." && \
	tar -czf backups/backup_$$TIMESTAMP.tar.gz -C backups $$TIMESTAMP && \
	rm -rf backups/$$TIMESTAMP && \
	echo "✅ Backup created: backups/backup_$$TIMESTAMP.tar.gz"

# Restore from backup
restore:
	@echo "🔄 Restore from backup"
	@echo "Available backups:"
	@ls -la backups/*.tar.gz 2>/dev/null || echo "No backups found"
	@echo ""
	@echo "To restore, specify the backup file:"
	@echo "  make restore-file BACKUP=backups/backup_YYYYMMDD_HHMMSS.tar.gz"

# Restore specific backup file
restore-file:
	@if [ -z "$(BACKUP)" ]; then \
		echo "❌ Please specify BACKUP file: make restore-file BACKUP=filename"; \
		exit 1; \
	fi
	@echo "🔄 Restoring from $(BACKUP)..."
	@echo "⚠️  This will overwrite current data! Continue? (y/N)"; \
	read -r confirm && [ "$$confirm" = "y" ] || exit 1
	@echo "📥 Extracting backup..."
	@tar -xzf $(BACKUP) -C backups/
	@BACKUP_DIR=$$(basename $(BACKUP) .tar.gz | sed 's/backup_//') && \
	echo "🛑 Stopping services..." && \
	docker-compose down && \
	echo "📥 Restoring database..." && \
	docker-compose up -d postgres && \
	sleep 5 && \
	docker-compose exec -T postgres psql -U postgres -c "DROP DATABASE IF EXISTS order_management;" && \
	docker-compose exec -T postgres psql -U postgres -c "CREATE DATABASE order_management;" && \
	docker-compose exec -T postgres psql -U postgres order_management < backups/$$BACKUP_DIR/database.sql && \
	echo "📥 Restoring uploads..." && \
	rm -rf uploads/* && \
	cp -r backups/$$BACKUP_DIR/uploads/* uploads/ 2>/dev/null || true && \
	echo "🚀 Restarting services..." && \
	docker-compose up -d && \
	rm -rf backups/$$BACKUP_DIR && \