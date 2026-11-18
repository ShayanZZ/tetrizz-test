#!/usr/bin/env bash
# A consistent copy of the TetriZZ database, with rotation and an optional off-site copy.
#
#   scripts/backup.sh
#
# SQLite:     a snapshot taken while the server runs (VACUUM INTO), checked, gzip-compressed.
# PostgreSQL: pg_dump in the custom format (compressed), checked with pg_restore --list.
# Copies go to $BACKUP_DIR/daily; one copy a week is also kept in $BACKUP_DIR/weekly. The newest
# BACKUP_KEEP_DAILY (7) and BACKUP_KEEP_WEEKLY (4) are kept. With BACKUP_RCLONE_REMOTE set, the new
# copy is also sent there with rclone (copy only: nothing is ever deleted on the remote).
# Settings are read from the environment, then from .env. Exit code 0 only when the copy is sound.
set -Eeuo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BACKUP_DIR=$(abs_path "$(setting BACKUP_DIR ./backups)")
KEEP_DAILY=$(setting BACKUP_KEEP_DAILY 7)
KEEP_WEEKLY=$(setting BACKUP_KEEP_WEEKLY 4)
REMOTE=$(setting BACKUP_RCLONE_REMOTE "")
[[ $KEEP_DAILY =~ ^[1-9][0-9]*$ && $KEEP_WEEKLY =~ ^[0-9]+$ ]] || die "BACKUP_KEEP_DAILY must be 1 or more and BACKUP_KEEP_WEEKLY 0 or more"

mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"

# One backup at a time (flock is part of util-linux; without it the check is skipped).
if command -v flock >/dev/null 2>&1; then
  exec 9>"$BACKUP_DIR/.lock"
  flock -n 9 || die "another backup is running"
fi

driver=$(detect_driver)
stamp=$(date -u +%Y%m%d-%H%M%S)
tmp="$BACKUP_DIR/.partial-$stamp"
trap 'rm -f -- "$tmp"' EXIT

if [[ $driver == postgres ]]; then
  name="tetrizz-postgres-$stamp.dump"
  log "backing up PostgreSQL"
  docker compose exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner' >"$tmp" ||
    die "pg_dump failed"
  [[ -s $tmp ]] || die "pg_dump produced an empty file"
  docker compose exec -T postgres pg_restore --list <"$tmp" >/dev/null || die "the dump cannot be read back (pg_restore --list failed)"
else
  name="tetrizz-sqlite-$stamp.db.gz"
  log "backing up SQLite"
  # The snapshot is made next to the database (the data folder is the only place with room; the
  # container's /tmp is small and counts against its memory) and removed again in every case.
  docker compose exec -T server sh -c '
    d=$(dirname "${SQLITE_PATH:-/data/sqlite/tetrizz.db}")
    t=$(mktemp "$d/.backup-XXXXXX")
    node tools/sqlite-backup.mjs "$t" >&2 && gzip -c "$t"
    rc=$?
    rm -f "$t"
    exit $rc' >"$tmp" || die "the snapshot failed"
  [[ -s $tmp ]] || die "the snapshot is empty"
  gzip -t "$tmp" || die "the compressed snapshot is damaged"
fi

mv -- "$tmp" "$BACKUP_DIR/daily/$name"
size=$(du -h "$BACKUP_DIR/daily/$name" | cut -f1)
log "backup ok: daily/$name ($size)"

# A weekly copy when there is none from the last seven days.
if ((KEEP_WEEKLY > 0)) && [[ -z $(find "$BACKUP_DIR/weekly" -maxdepth 1 -type f -name 'tetrizz-*' -mtime -7 -print -quit) ]]; then
  cp -- "$BACKUP_DIR/daily/$name" "$BACKUP_DIR/weekly/$name"
  log "weekly copy: weekly/$name"
fi

# Keep the newest N of each, whatever the database was when they were made.
prune() {
  local dir=$1 keep=$2 i=0 file
  while IFS= read -r file; do
    i=$((i + 1))
    if ((i > keep)); then
      rm -f -- "$file"
      log "removed old copy: ${file#"$BACKUP_DIR"/}"
    fi
  done < <(find "$dir" -maxdepth 1 -type f -name 'tetrizz-*' -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
}
prune "$BACKUP_DIR/daily" "$KEEP_DAILY"
prune "$BACKUP_DIR/weekly" "$KEEP_WEEKLY"

if [[ -n $REMOTE ]]; then
  if ! command -v rclone >/dev/null 2>&1; then
    log "WARNING: BACKUP_RCLONE_REMOTE is set but rclone is not installed; no off-site copy" >&2
    exit 2
  fi
  if rclone copy "$BACKUP_DIR/daily/$name" "$REMOTE/daily"; then
    log "off-site copy ok: $REMOTE/daily/$name"
  else
    log "WARNING: the off-site copy failed (the local copy is fine)" >&2
    exit 2
  fi
fi
