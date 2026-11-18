#!/usr/bin/env bash
# Puts a backup made by scripts/backup.sh back as the live database.
#
#   scripts/restore.sh [--yes] backups/daily/tetrizz-sqlite-20261117-031700.db.gz
#
# The server is stopped while this runs and started again at the end. The file is checked first and
# nothing is touched if it is damaged. SQLite: the old database file is kept next to the new one as
# tetrizz.db.before-restore-<time> (delete it when you are happy). PostgreSQL: a dump of the current
# database is written to $BACKUP_DIR/before-restore-<time>.dump first, and the restore runs in one
# transaction, so it is all or nothing. A backup made by an older version is brought up to date by
# the server's migrations when it starts; a backup made by a newer version is refused by the server.
set -Eeuo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

assume_yes=0
if [[ ${1-} == --yes ]]; then
  assume_yes=1
  shift
fi
[[ $# -eq 1 ]] || die "usage: scripts/restore.sh [--yes] <backup file>"
file=$(abs_path "$1")
[[ -f $file ]] || die "no such file: $1"
[[ -s $file ]] || die "the file is empty: $1"

driver=$(detect_driver)
case $file in
  *.db.gz) kind=sqlite ;;
  *.dump) kind=postgres ;;
  *) die "do not know this kind of file (expected .db.gz from SQLite or .dump from PostgreSQL)" ;;
esac
[[ $kind == "$driver" ]] || die "this is a $kind backup but the stack is set up for $driver"

if [[ $kind == sqlite ]]; then
  gzip -t "$file" || die "the file is damaged (gzip test failed)"
else
  docker compose exec -T postgres pg_restore --list <"$file" >/dev/null || die "the file is damaged (pg_restore --list failed)"
fi

if ((!assume_yes)); then
  printf 'This replaces the live %s database with\n  %s\nThe server is stopped meanwhile. Type RESTORE to go on: ' "$kind" "$1"
  read -r answer
  [[ $answer == RESTORE ]] || die "cancelled"
fi

stamp=$(date -u +%Y%m%d-%H%M%S)
log "stopping the server"
docker compose stop server

if [[ $kind == sqlite ]]; then
  # Runs in the server image as the user that owns the data folder, with the old database in place.
  # The new file is written and checked beside it and only then swapped in.
  docker compose run --rm --no-deps -T --entrypoint sh server -c '
    set -e
    db=${SQLITE_PATH:-/data/sqlite/tetrizz.db}
    new="$db.restoring"
    trap "rm -f \"$new\"" EXIT
    mkdir -p "$(dirname "$db")"
    gunzip -c >"$new"
    node tools/sqlite-backup.mjs --check "$new" >&2
    if [ -f "$db" ]; then mv "$db" "$db.before-restore-'"$stamp"'"; fi
    rm -f "$db-wal" "$db-shm"
    mv "$new" "$db"' <"$file" || die "the restore failed; the server is stopped, the old database was not replaced unless it says so above"
else
  docker compose up -d postgres
  wait_ready postgres || die "PostgreSQL did not become healthy"
  safety="$(abs_path "$(setting BACKUP_DIR ./backups)")/before-restore-$stamp.dump"
  mkdir -p "$(dirname "$safety")"
  if docker compose exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner' >"$safety" && [[ -s $safety ]]; then
    log "dump of the current database: $safety"
  else
    rm -f -- "$safety"
    log "WARNING: could not dump the current database first" >&2
  fi
  docker compose exec -T postgres sh -c 'exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --single-transaction' <"$file" ||
    die "pg_restore failed; nothing was changed (single transaction); the server is stopped"
fi

log "starting the server"
docker compose up -d server
wait_ready server || die "the server did not become healthy after the restore; look at: docker compose logs server"
log "restore ok"
