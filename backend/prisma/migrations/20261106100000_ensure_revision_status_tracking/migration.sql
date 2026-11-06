BEGIN;
-- Also run after db push: Prisma schema synchronization does not install triggers.
-- Serialize installation and prevent status writes between trigger replacement and backfill.
SELECT pg_advisory_xact_lock(174704, 179920);
LOCK TABLE "BluesalesOrderInfo" IN SHARE ROW EXCLUSIVE MODE;

-- Verified against BluesalesOrderStatus on 2026-11-04:
-- 174704 = Правки у художника; 179920 = Правка готова.
-- Run on the same locked status row/transaction as every local or imported change.
-- A repeated sync of the same status does not create another cycle.
CREATE OR REPLACE FUNCTION metalica_revision_status_transition() RETURNS trigger AS $$
DECLARE
  changed_at timestamp(3) := CURRENT_TIMESTAMP;
  artist_id integer;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."orderStatusId" IS NOT DISTINCT FROM NEW."orderStatusId" THEN
    RETURN NEW;
  END IF;
  IF NEW."orderStatusId" = 174704 THEN
    INSERT INTO "Revision" ("orderId", "openedAt", "createdAt")
      SELECT NEW."orderId", changed_at, changed_at
      WHERE NOT EXISTS (
        SELECT 1 FROM "Revision" r
        WHERE r."orderId" = NEW."orderId"
          AND NOT EXISTS (SELECT 1 FROM "RevisionClosure" c WHERE c."revisionId" = r.id)
      );
  ELSIF NEW."orderStatusId" = 179920 THEN
    SELECT "revisionDesignerId" INTO artist_id FROM "Order" WHERE id = NEW."orderId";
    INSERT INTO "RevisionClosure" ("revisionId", "closedById", "openedAt", "closedAt", "createdAt")
      SELECT r.id, artist_id, r."openedAt", GREATEST(changed_at, r."openedAt"), changed_at
      FROM "Revision" r
      WHERE r."orderId" = NEW."orderId"
        AND NOT EXISTS (SELECT 1 FROM "RevisionClosure" c WHERE c."revisionId" = r.id)
      ON CONFLICT ("revisionId") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS metalica_revision_status_transition ON "BluesalesOrderInfo";
CREATE TRIGGER metalica_revision_status_transition
AFTER INSERT OR UPDATE OF "orderStatusId" ON "BluesalesOrderInfo"
FOR EACH ROW EXECUTE FUNCTION metalica_revision_status_transition();

-- Preserve ALL currently active legacy requests, even when their current status differs.
-- Orders already with an artist but without a legacy request get their first cycle.
INSERT INTO "Revision" ("orderId", "openedAt", "createdAt")
SELECT b."orderId", COALESCE(b."orderStatusEnteredAt", CURRENT_TIMESTAMP), CURRENT_TIMESTAMP
FROM "BluesalesOrderInfo" b
WHERE b."orderStatusId" = 174704
  AND NOT EXISTS (
    SELECT 1 FROM "Revision" r WHERE r."orderId" = b."orderId"
      AND NOT EXISTS (SELECT 1 FROM "RevisionClosure" c WHERE c."revisionId" = r.id)
  );

COMMIT;
