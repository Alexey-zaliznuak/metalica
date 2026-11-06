-- Revision tracking now runs in application transactions. Keep old migrations
-- unchanged so databases with an existing Prisma history retain their checksums.
BEGIN;
DROP TRIGGER IF EXISTS metalica_revision_status_transition ON "BluesalesOrderInfo";
DROP FUNCTION IF EXISTS metalica_revision_status_transition();
COMMIT;
