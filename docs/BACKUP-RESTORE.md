# Backup and Restore Guide

## What is backed up

The `scripts/backup-postgres.sh` script dumps the entire `whatsapp_automation`
PostgreSQL database using `pg_dump`. This captures:

- All tenant accounts (`users`)
- Contacts, messages, CRM deals, lead analyses
- Chatbot rules, scheduled messages, settings
- Google Calendar OAuth tokens (`google_calendar_accounts`) ← **sensitive**
- Appointments and availability settings

**NOT backed up by this script:**
- WhatsApp session auth (`.wwebjs_auth/`) — sessions reconnect automatically after a QR re-scan
- The session-signing secret (`data/.session_secret`) — losing it logs everyone out but is not data loss

---

## Automatic daily backup (Docker production)

`docker-compose.prod.yml` includes a `backup` service that runs the script
daily at **02:00 UTC** and keeps the last **14 days** of backups.

To enable it, add the backup volume to your deployment:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Backups are written to the `backup-data` Docker volume. To find the host path:

```bash
docker volume inspect whatsapp-automation_backup-data
```

---

## Manual backup

```bash
# Bare server (pg_dump must be installed):
DATABASE_URL=postgresql://postgres:pass@localhost:5432/whatsapp_automation \
  ./scripts/backup-postgres.sh ./backups/manual

# Docker (uses the postgres image, no local pg_dump needed):
docker run --rm \
  -e DATABASE_URL=postgresql://postgres:pass@host.docker.internal:5432/whatsapp_automation \
  -v "$(pwd)/backups:/backups" \
  -v "$(pwd)/scripts/backup-postgres.sh:/backup.sh:ro" \
  postgres:17-alpine sh /backup.sh /backups
```

The script writes a gzip-compressed SQL file:
```
backups/whatsapp_pg_20261012_020000.sql.gz
```

It also prints a SHA-256 checksum. Store it alongside the backup file.

---

## Restore into a scratch database (restore test procedure)

**Always test into a scratch database first. Never restore directly into production.**

### Step 1 — Create a scratch database

```bash
docker exec wa-postgres psql -U postgres -c "CREATE DATABASE wa_restore_test;"
```

### Step 2 — Run the restore script

```bash
RESTORE_URL=postgresql://postgres:postgres@localhost:5432/wa_restore_test

docker exec -i wa-postgres \
  bash -c "PGPASSWORD=postgres gunzip -c - | psql -U postgres wa_restore_test" \
  < backups/whatsapp_pg_20261012_020000.sql.gz
```

Or using the restore script directly on a server with `psql` installed:

```bash
./scripts/restore-postgres.sh \
  backups/whatsapp_pg_20261012_020000.sql.gz \
  postgresql://postgres:postgres@localhost:5432/wa_restore_test
```

### Step 3 — Verify row counts

```bash
docker exec wa-postgres psql -U postgres -d wa_restore_test -c "
  SELECT 'users' as tbl, count(*) FROM users
  UNION ALL SELECT 'contacts', count(*) FROM contacts
  UNION ALL SELECT 'messages', count(*) FROM messages
  UNION ALL SELECT 'crm_deals', count(*) FROM crm_deals;
"
```

Compare counts against the production database. If they match, the backup is good.

### Step 4 — Clean up scratch database

```bash
docker exec wa-postgres psql -U postgres -c "DROP DATABASE wa_restore_test;"
```

---

## Restore into production (disaster recovery)

Only do this when the production database is gone or corrupted.

```bash
# 1. Stop the application to prevent writes during restore
docker compose stop app

# 2. Restore into production
./scripts/restore-postgres.sh \
  backups/whatsapp_pg_20261012_020000.sql.gz \
  postgresql://postgres:pass@localhost:5432/whatsapp_automation \
  --force

# 3. Restart the application
docker compose start app
```

The `--force` flag skips the interactive confirmation prompt and the
"database already contains data" guard. Use it only when you are certain
the target is correct.

---

## Security notes

1. **Backup files contain plaintext OAuth tokens** (Google Calendar). Store
   them on encrypted volumes with `chmod 0600` (the script sets this automatically).

2. **Never commit backups to Git** — `backups/` is in `.gitignore`.

3. **Rotate Google Calendar tokens** after a suspected backup leak by having
   each affected tenant disconnect and reconnect Google Calendar from Settings.

4. **The script uses PGPASSWORD environment variable**, never command-line
   arguments, so the password does not appear in `ps aux` output.
