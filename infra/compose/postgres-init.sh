#!/bin/sh
set -eu
for migration in /canonical-migrations/*.sql; do
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -f "$migration"
done
psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -f /local-collab-login.sql
