#!/bin/bash

# Backup script for Order Management System
set -e

# Configuration
BACKUP_DIR="/app/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="backup_${TIMESTAMP}"
RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-30}

# Database configuration
DB_HOST=${DATABASE_HOST:-postgres}
DB_PORT=${DATABASE_PORT:-5432}
DB_NAME=${DATABASE_NAME:-order_management}
DB_USER=${DATABASE_USER:-postgres}

# Logging
log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

# Create backup directory
mkdir -p "${BACKUP_DIR}"

log "Starting backup: ${BACKUP_NAME}"

# Create temporary directory for this backup
TEMP_DIR="${BACKUP_DIR}/${BACKUP_NAME}"
mkdir -p "${TEMP_DIR}"

# Database backup
log "Backing up database..."
pg_dump -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" \
    --no-password --verbose --format=custom \
    > "${TEMP_DIR}/database.dump"

if [ $? -eq 0 ]; then
    log "Database backup completed"
else
    log "ERROR: Database backup failed"
    exit 1
fi

# Create backup metadata
cat > "${TEMP_DIR}/metadata.json" << EOF
{
    "timestamp": "${TIMESTAMP}",
    "database": "${DB_NAME}",
    "version": "1.0",
    "type": "full",
    "files": [
        "database.dump",
        "metadata.json"
    ]
}
EOF

# Create compressed archive
log "Creating compressed archive..."
cd "${BACKUP_DIR}"
tar -czf "${BACKUP_NAME}.tar.gz" "${BACKUP_NAME}"

# Verify archive
if [ -f "${BACKUP_NAME}.tar.gz" ]; then
    ARCHIVE_SIZE=$(du -h "${BACKUP_NAME}.tar.gz" | cut -f1)
    log "Archive created: ${BACKUP_NAME}.tar.gz (${ARCHIVE_SIZE})"
    
    # Remove temporary directory
    rm -rf "${TEMP_DIR}"
else
    log "ERROR: Failed to create archive"
    exit 1
fi

# Upload to S3 if configured
if [ -n "${AWS_S3_BUCKET}" ] && [ -n "${AWS_ACCESS_KEY_ID}" ]; then
    log "Uploading to S3..."
    aws s3 cp "${BACKUP_DIR}/${BACKUP_NAME}.tar.gz" \
        "s3://${AWS_S3_BUCKET}/backups/${BACKUP_NAME}.tar.gz" \
        --region "${AWS_REGION:-us-east-1}"
    
    if [ $? -eq 0 ]; then
        log "S3 upload completed"
    else
        log "WARNING: S3 upload failed"
    fi
fi

# Clean up old backups
log "Cleaning up old backups (older than ${RETENTION_DAYS} days)..."
find "${BACKUP_DIR}" -name "backup_*.tar.gz" -type f -mtime +${RETENTION_DAYS} -exec rm -f {} \;

# Clean up old S3 backups if configured
if [ -n "${AWS_S3_BUCKET}" ] && [ -n "${AWS_ACCESS_KEY_ID}" ]; then
    CUTOFF_DATE=$(date -d "${RETENTION_DAYS} days ago" +%Y%m%d)
    aws s3 ls "s3://${AWS_S3_BUCKET}/backups/" --region "${AWS_REGION:-us-east-1}" | \
    while read -r line; do
        backup_date=$(echo $line | grep -o 'backup_[0-9]\{8\}' | cut -d'_' -f2)
        if [ -n "$backup_date" ] && [ "$backup_date" -lt "$CUTOFF_DATE" ]; then
            backup_file=$(echo $line | awk '{print $4}')
            log "Removing old S3 backup: $backup_file"
            aws s3 rm "s3://${AWS_S3_BUCKET}/backups/$backup_file" --region "${AWS_REGION:-us-east-1}"
        fi
    done
fi

log "Backup completed successfully: ${BACKUP_NAME}.tar.gz"

# If running as cron job, schedule next backup
if [ -n "${BACKUP_SCHEDULE}" ]; then
    log "Scheduling next backup with cron: ${BACKUP_SCHEDULE}"
    echo "${BACKUP_SCHEDULE} /app/scripts/backup.sh" | crontab -
    crond -f &
    wait
fi