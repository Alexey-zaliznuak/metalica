#!/bin/sh
set -e

echo "Waiting for database..."
npx prisma db push --skip-generate --accept-data-loss

echo "Seeding database..."
node prisma/seed.js || echo "Seed skipped/failed (non-fatal)"

echo "Starting backend..."
exec node dist/main.js
