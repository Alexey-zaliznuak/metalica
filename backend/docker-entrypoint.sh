#!/bin/sh
set -e

echo "Waiting for database..."
npx prisma db push --skip-generate --accept-data-loss

echo "Removing legacy revision trigger..."
# db push does not remove SQL triggers. Tracking now runs in application services.
npx prisma db execute --schema prisma/schema.prisma --file prisma/migrations/20261106110000_service_revision_tracking/migration.sql

echo "Seeding database..."
node prisma/seed.js || echo "Seed skipped/failed (non-fatal)"

echo "Starting backend..."
exec node dist/main.js
