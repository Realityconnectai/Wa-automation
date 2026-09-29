#!/usr/bin/env bash
# scripts/restore-postgres.sh
# PostgreSQL database restore script for WhatsApp Automation
#
# Restores a gzipped pg_dump SQL file into a specified target PostgreSQL database.
#
# CAUTION:
#   This will execute SQL statements against the target database.
#   Always verify TARGET_DATABASE_URL points to the intended target database (e.g. staging or test).
#
# Usage:
#   ./scripts/restore-postgres.sh <path-to-backup.sql.gz> [TARGET_DATABASE_URL] [--force]

set -euo pipefail

BACKUP_FILE="${1:-}"
TARGET_URL="${2:-${DATABASE_URL:-}}"
FORCE=false
for arg in "$@"; do
    if [ "$arg" = "--force" ]; then FORCE=true; fi
done

if [ -z "${BACKUP_FILE}" ] || [ ! -f "${BACKUP_FILE}" ]; then
    echo "❌ Error: Backup file path is required and must exist." >&2
    echo "Usage: $0 <path-to-backup.sql.gz> [TARGET_DATABASE_URL] [--force]" >&2
    exit 1
fi

if [ -z "${TARGET_URL}" ] && [ -z "${PGDATABASE:-}" ]; then
    echo "❌ Error: TARGET_DATABASE_URL or DATABASE_URL must be provided." >&2
    exit 1
fi

# Secure credential parsing: avoid passing passwords in command line arguments (visible in ps)
if [ -n "${TARGET_URL:-}" ]; then
    PROTO="$(echo "${TARGET_URL}" | grep :// | sed -e's,^\(.*://\).*,\1,g')"
    URL_NO_PROTO="${TARGET_URL#"$PROTO"}"
    USER_PASS="$(echo "${URL_NO_PROTO}" | grep @ | cut -d@ -f1 || true)"
    HOST_PORT_DB="$(echo "${URL_NO_PROTO}" | sed -e "s,^.*@,,g")"

    if [ -n "${USER_PASS}" ]; then
        EXTRACTED_USER="$(echo "${USER_PASS}" | cut -d: -f1)"
        EXTRACTED_PASS="$(echo "${USER_PASS}" | grep : | cut -d: -f2- || true)"
        if [ -n "${EXTRACTED_PASS}" ]; then export PGPASSWORD="${EXTRACTED_PASS}"; fi
        if [ -n "${EXTRACTED_USER}" ]; then export PGUSER="${EXTRACTED_USER}"; fi
    fi

    HOST_PORT="$(echo "${HOST_PORT_DB}" | cut -d/ -f1)"
    EXTRACTED_DB="$(echo "${HOST_PORT_DB}" | grep / | cut -d/ -f2- | cut -d? -f1 || true)"
    EXTRACTED_HOST="$(echo "${HOST_PORT}" | cut -d: -f1)"
    EXTRACTED_PORT="$(echo "${HOST_PORT}" | grep : | cut -d: -f2 || true)"

    if [ -n "${EXTRACTED_HOST}" ]; then export PGHOST="${EXTRACTED_HOST}"; fi
    if [ -n "${EXTRACTED_PORT}" ]; then export PGPORT="${EXTRACTED_PORT}"; fi
    if [ -n "${EXTRACTED_DB}" ]; then export PGDATABASE="${EXTRACTED_DB}"; fi
fi

echo "===================================================="
echo "⚠️  POSTGRESQL DATABASE RESTORE"
echo "===================================================="
echo "Backup File: ${BACKUP_FILE}"
echo "Target DB:   ${PGDATABASE:-target_database} on ${PGHOST:-localhost}:${PGPORT:-5432}"
echo "----------------------------------------------------"

# Target baseline check: check if target database already contains application data
EXISTING_TABLES=$(psql -t -A -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('users', 'contacts', 'messages', 'chatbot_rules', 'scheduled_messages', 'settings', 'products', 'crm_deals', 'crm_activities', 'lead_analysis', 'google_calendar_accounts', 'google_calendar_synced_events', 'availability_settings', 'appointments');" 2>/dev/null || echo "0")

if [ "${EXISTING_TABLES}" -gt 0 ] && [ "${FORCE}" != "true" ]; then
    echo "❌ Error: Target database already contains existing application tables (${EXISTING_TABLES} matched). Refusing to restore over existing data without --force." >&2
    exit 1
fi

# Confirm restore if in interactive terminal
if [ -t 0 ] && [ "${FORCE}" != "true" ]; then
    read -p "Are you sure you want to restore into this target database? (yes/no): " CONFIRM
    if [ "${CONFIRM}" != "yes" ]; then
        echo "Restore aborted by user."
        exit 0
    fi
fi

echo "🔄 Restoring database..."
gunzip -c "${BACKUP_FILE}" | psql --single-transaction --set ON_ERROR_STOP=on

echo "✔ Database restored successfully."
