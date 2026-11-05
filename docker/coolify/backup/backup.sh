#!/bin/bash
#
# LEGA backups for the Coolify stack.
#
#   lega-backup schedule   run every day at BACKUP_HOUR_UTC (the container default)
#   lega-backup now        take a backup right away
#   lega-backup list       show the local backups
#
# Each run writes two files to $BACKUP_DIR:
#   lega-db-<time>.sql.gz      every MariaDB database (system + one per organization)
#   lega-files-<time>.tar.gz   the Garage volume (attachments, logos, documents)
#
# Local copies older than BACKUP_KEEP_DAYS are removed. When BACKUP_S3_BUCKET
# is set, each run also copies the files to that S3-compatible bucket.

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
HOUR_UTC="${BACKUP_HOUR_UTC:-2}"
GARAGE_DATA="${GARAGE_DATA_DIR:-/garage-data}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

copy_offsite() {
  if [ -z "${BACKUP_S3_BUCKET:-}" ]; then
    log "Off-site copy skipped (BACKUP_S3_BUCKET is not set)."
    return 0
  fi
  export RCLONE_CONFIG_OFFSITE_TYPE=s3
  export RCLONE_CONFIG_OFFSITE_PROVIDER="${BACKUP_S3_PROVIDER:-Other}"
  export RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY_ID:-}"
  export RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_ACCESS_KEY:-}"
  export RCLONE_CONFIG_OFFSITE_ENDPOINT="${BACKUP_S3_ENDPOINT:-}"
  export RCLONE_CONFIG_OFFSITE_REGION="${BACKUP_S3_REGION:-auto}"
  export RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET=true
  local dest="offsite:${BACKUP_S3_BUCKET}/${BACKUP_S3_PATH:-lega}"
  log "Copying backups to ${BACKUP_S3_BUCKET}/${BACKUP_S3_PATH:-lega}..."
  rclone copy "$BACKUP_DIR" "$dest" --include 'lega-*' --stats-one-line
}

backup_now() {
  mkdir -p "$BACKUP_DIR"
  local ts db files
  ts=$(date -u +%Y%m%d-%H%M%S)
  db="$BACKUP_DIR/lega-db-$ts.sql.gz"
  files="$BACKUP_DIR/lega-files-$ts.tar.gz"

  log "Dumping all databases from $DB_HOST..."
  MYSQL_PWD="$DB_PASSWORD" mariadb-dump \
    -h "$DB_HOST" -u "$DB_USER" \
    --all-databases --single-transaction --quick \
    --routines --events --triggers \
    | gzip > "$db.part"
  mv "$db.part" "$db"
  log "Saved $(basename "$db") ($(du -h "$db" | cut -f1))."

  if [ -d "$GARAGE_DATA" ]; then
    log "Archiving uploaded files..."
    tar -czf "$files.part" -C "$GARAGE_DATA" .
    mv "$files.part" "$files"
    log "Saved $(basename "$files") ($(du -h "$files" | cut -f1))."
  fi

  find "$BACKUP_DIR" -maxdepth 1 -name 'lega-*' -mtime +"$KEEP_DAYS" -print -delete \
    | sed 's/^/Removed old backup: /'
  find "$BACKUP_DIR" -maxdepth 1 -name '*.part' -mmin +240 -delete

  copy_offsite
  log "Backup finished."
}

seconds_until_next_run() {
  local now next
  now=$(date -u +%s)
  next=$(date -u -d "today ${HOUR_UTC}:00" +%s)
  if [ "$next" -le "$now" ]; then
    next=$(date -u -d "tomorrow ${HOUR_UTC}:00" +%s)
  fi
  echo $((next - now))
}

schedule() {
  log "Daily backups at ${HOUR_UTC}:00 UTC, keeping ${KEEP_DAYS} days in $BACKUP_DIR."
  # Take a first backup if none exists from the last day (e.g. a fresh deploy).
  if [ -z "$(find "$BACKUP_DIR" -maxdepth 1 -name 'lega-db-*.sql.gz' -mmin -1440 2>/dev/null)" ]; then
    backup_now || log "Backup FAILED."
  fi
  while true; do
    sleep "$(seconds_until_next_run)"
    backup_now || log "Backup FAILED."
  done
}

case "${1:-schedule}" in
  schedule) schedule ;;
  now) backup_now ;;
  list) ls -lh "$BACKUP_DIR" ;;
  *) echo "Usage: lega-backup [schedule|now|list]" >&2; exit 2 ;;
esac
