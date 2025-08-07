# Backup Service Dockerfile
FROM postgres:15-alpine

# Install cron and other utilities
RUN apk add --no-cache \
    bash \
    curl \
    gzip \
    aws-cli \
    && rm -rf /var/cache/apk/*

# Create backup user
RUN addgroup -g 1001 -S backup && adduser -S backup -u 1001

# Create backup directory
RUN mkdir -p /app/backups /app/scripts && \
    chown -R backup:backup /app

# Copy backup scripts
COPY backup.sh /app/scripts/backup.sh
COPY restore.sh /app/scripts/restore.sh

# Make scripts executable
RUN chmod +x /app/scripts/*.sh

# Switch to backup user
USER backup

# Set working directory
WORKDIR /app

# Default command
CMD ["/app/scripts/backup.sh"]