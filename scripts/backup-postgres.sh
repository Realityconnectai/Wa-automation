#!/usr/bin/env bash
# scripts/backup-postgres.sh
# PostgreSQL database backup script for WhatsApp Automation
#
# IMPORTANT SECURITY NOTICE:
#   This database dump contains sensitive application data, including:
#   - Google Calendar OAuth access & refresh tokens (google_calendar_accounts)
#   - User password hashes (users)
#   - Customer phone numbers, names, and notes (contacts)
#   - Chatbot messages and business records (messages, crm_deals)
#   Backup files must be treated as CONFIDENTIAL and stored with restrictive
#   permissions (0600) on encrypted volumes or dedicated backup storage.
#   WhatsApp session files (.wwebjs_auth) and .session_secret are kept separate.
#
# Usage:
#   ./scripts/backup-postgres.sh [output_dir]

set -euo pipefail
umask 077

BACKUP_DIR="${1:-./backups/postgres}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/whatsapp_pg_${TIMESTAMP}.sql.gz"
TEMP_BACKUP_FILE="${BACKUP_FILE}.tmp.$$"

# Ensure cleanup of partial file on any exit before success
trap 'rm -f "${TEMP_BACKUP_FILE}"' EXIT INT TERM

mkdir -p "${BACKUP_DIR}"
chmod 0700 "${BACKUP_DIR}" 2>/dev/null || true

if [ -z "${DATABASE_URL:-}" ] && [ -z "${PGDATABASE:-}" ]; then
    echo "❌ Error: DATABASE_URL or PGDATABASE environment variable is not set." >&2
    exit 1
fi

# Secure credential parsing: avoid passing passwords in command line arguments (visible in ps)
if [ -n "${DATABASE_URL:-}" ]; then
    # Parse URL without exposing credentials: postgresql://[user[:password]@]host[:port][/dbname]
    PROTO="$(echo "${DATABASE_URL}" | grep :// | sed -e's,^\(.*://\).*,\1,g')"
    URL_NO_PROTO="${DATABASE_URL#"$PROTO"}"
    USER_PASS="$(echo "${URL_NO_PROTO}" | grep @ | cut -d@ -f1 || true)"
    HOST_PORT_DB="$(echo "${URL_NO_PROTO}" | sed -e "s,^.*@,,g")"

    if [ -n "${USER_PASS}" ]; then
        EXTRACTED_USER="$(echo "${USER_PASS}" | cut -d: -f1)"
        EXTRACTED_PASS="$(echo "${USER_PASS}" | grep : | cut -d: -f2- || true)"
        if [ -n "${EXTRACTED_PASS}" ]; then
            export PGPASSWORD="${EXTRACTED_PASS}"
        fi
        if [ -n "${EXTRACTED_USER}" ]; then
            export PGUSER="${EXTRACTED_USER}"
        fi
    fi

    HOST_PORT="$(echo "${HOST_PORT_DB}" | cut -d/ -f1)"
    EXTRACTED_DB="$(echo "${HOST_PORT_DB}" | grep / | cut -d/ -f2- | cut -d? -f1 || true)"

    EXTRACTED_HOST="$(echo "${HOST_PORT}" | cut -d: -f1)"
    EXTRACTED_PORT="$(echo "${HOST_PORT}" | grep : | cut -d: -f2 || true)"

    if [ -n "${EXTRACTED_HOST}" ]; then export PGHOST="${EXTRACTED_HOST}"; fi
    if [ -n "${EXTRACTED_PORT}" ]; then export PGPORT="${EXTRACTED_PORT}"; fi
    if [ -n "${EXTRACTED_DB}" ]; then export PGDATABASE="${EXTRACTED_DB}"; fi
fi

echo "📦 Backing up PostgreSQL database (${PGDATABASE:-whatsapp_automation}) to: ${BACKUP_FILE}..."

# Execute pg_dump using environment variables (PGPASSWORD, PGHOST, etc.) so credentials are NOT in CLI args
# Atomic output: write to temp file first
pg_dump --no-owner --no-acl | gzip > "${TEMP_BACKUP_FILE}"

# Verify backup size
BACKUP_SIZE=$(wc -c < "${TEMP_BACKUP_FILE}")
if [ "${BACKUP_SIZE}" -le 100 ]; then
    echo "❌ Error: Backup failed: output file is empty or too small (${BACKUP_SIZE} bytes)." >&2
    exit 1
fi

# Set restrictive permissions before moving into place
chmod 0600 "${TEMP_BACKUP_FILE}" 2>/dev/null || true

# Atomic finalization
mv "${TEMP_BACKUP_FILE}" "${BACKUP_FILE}"
trap - EXIT INT TERM

echo "✔ Backup completed successfully (${BACKUP_SIZE} bytes)."
echo "✔ Checksum (SHA256): $(sha256sum "${BACKUP_FILE}" | cut -d' ' -f1)"
echo "🔒 File permissions set to restrictive (0600)."
