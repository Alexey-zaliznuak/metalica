#!/bin/sh
set -e

echo "Waiting for database..."
npx prisma db push --skip-generate --accept-data-loss

echo "Installing status-driven revision tracking..."
# db push cannot create SQL triggers. This step is idempotent and must succeed
# before the API or BlueSales workers can change order statuses.
npx prisma db execute --schema prisma/schema.prisma --file prisma/migrations/20261106100000_ensure_revision_status_tracking/migration.sql

echo "Seeding database..."
node prisma/seed.js || echo "Seed skipped/failed (non-fatal)"

echo "Starting backend..."
exec node dist/main.js
