#!/bin/sh
# Creates, or brings up to date, the read-only PostgreSQL role that Grafana's business dashboards use.
# Safe to run again: every `docker compose up` runs it. It runs as the server's own database user, so
# the default privileges below cover every table that user creates later (a new migration).
#   PGHOST, PGUSER, PGPASSWORD, PGDATABASE   how to reach the database (the server's own login)
#   ANALYTICS_DB_PASSWORD                    the password of the read-only role (required)
#   ANALYTICS_DB_USER                        the role's name (default grafana_ro)
#   ANALYTICS_DB_SCHEMA                      the schema that holds the tables (default public, DB_SCHEMA)
set -eu

: "${ANALYTICS_DB_PASSWORD:?set ANALYTICS_DB_PASSWORD in .env}"
role=${ANALYTICS_DB_USER:-grafana_ro}
schema=${ANALYTICS_DB_SCHEMA:-public}
: "${PGDATABASE:?PGDATABASE is not set}"

case $role$schema in
  *[!a-zA-Z0-9_]*)
    echo "ANALYTICS_DB_USER and ANALYTICS_DB_SCHEMA may hold letters, digits and _ only" >&2
    exit 1
    ;;
esac

psql -X -q -v ON_ERROR_STOP=1 -v role="$role" -v schema="$schema" -v dbname="$PGDATABASE" <<'SQL'
\getenv pw ANALYTICS_DB_PASSWORD
SELECT format('CREATE ROLE %I LOGIN', :'role') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 5', :'role', :'pw') \gexec
ALTER ROLE :"role" SET default_transaction_read_only = on;
ALTER ROLE :"role" SET statement_timeout = '30s';
ALTER ROLE :"role" SET search_path = :"schema";
GRANT CONNECT ON DATABASE :"dbname" TO :"role";
GRANT USAGE ON SCHEMA :"schema" TO :"role";
GRANT SELECT ON ALL TABLES IN SCHEMA :"schema" TO :"role";
ALTER DEFAULT PRIVILEGES IN SCHEMA :"schema" GRANT SELECT ON TABLES TO :"role";
SQL
echo "read-only role $role is ready"
