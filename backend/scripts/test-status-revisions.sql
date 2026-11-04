-- Run ONLY against an empty disposable local database with psql -v ON_ERROR_STOP=1.
-- All fixtures live in a dedicated schema, removed on success.
CREATE SCHEMA revision_fixture;
SET search_path TO revision_fixture;
CREATE TABLE "User" (id serial PRIMARY KEY);
CREATE TABLE "Order" (id serial PRIMARY KEY, "revisionDesignerId" integer REFERENCES "User");
CREATE TABLE "Message" (id serial PRIMARY KEY);
CREATE TABLE "Revision" (id serial PRIMARY KEY, "orderId" integer NOT NULL REFERENCES "Order",
 "messageId" integer NOT NULL UNIQUE CONSTRAINT "Revision_messageId_fkey" REFERENCES "Message" ON DELETE CASCADE,
 "openedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE "RevisionClosure" (id serial PRIMARY KEY, "revisionId" integer NOT NULL UNIQUE REFERENCES "Revision",
 "messageId" integer UNIQUE REFERENCES "Message", "closedById" integer NOT NULL CONSTRAINT "RevisionClosure_closedById_fkey" REFERENCES "User",
 "openedAt" timestamp(3) NOT NULL, "closedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE "BluesalesOrderInfo" ("orderId" integer PRIMARY KEY REFERENCES "Order", "orderStatusId" integer,
 "orderStatusEnteredAt" timestamp(3));
INSERT INTO "User" VALUES(1);
INSERT INTO "Order" VALUES (1,1),(2,NULL),(3,1),(4,1);
INSERT INTO "Message" VALUES(1),(2);
INSERT INTO "Revision" ("orderId","messageId","openedAt") VALUES (1,1,'2026-01-01'),(4,2,'2026-02-01');
INSERT INTO "BluesalesOrderInfo" VALUES(1,174704,NULL),(2,174704,NULL),(3,1,NULL),(4,179920,NULL);

\ir ../prisma/migrations/20261104120000_status_driven_revisions/migration.sql

DO $$ BEGIN
 IF (SELECT count(*) FROM "Revision") <> 3 THEN RAISE EXCEPTION 'backfill duplicates legacy cycle'; END IF;
 IF (SELECT count(*) FROM "RevisionClosure") <> 0 THEN RAISE EXCEPTION 'migration closes active requests'; END IF;
END $$;
-- Delete legacy message: revision must survive independently.
DELETE FROM "Message" WHERE id=1;
UPDATE "BluesalesOrderInfo" SET "orderStatusId"=174704 WHERE "orderId"=1;
UPDATE "BluesalesOrderInfo" SET "orderStatusId"=179920 WHERE "orderId" IN(1,2);
UPDATE "BluesalesOrderInfo" SET "orderStatusId"=179920 WHERE "orderId"=1;
DO $$ BEGIN
 IF (SELECT count(*) FROM "Revision") <> 3 THEN RAISE EXCEPTION 'same status duplicates cycle'; END IF;
 IF (SELECT count(*) FROM "RevisionClosure") <> 2 THEN RAISE EXCEPTION 'close must be idempotent'; END IF;
 IF (SELECT "closedById" FROM "RevisionClosure" c JOIN "Revision" r ON r.id=c."revisionId" WHERE r."orderId"=1) <> 1 THEN RAISE EXCEPTION 'wrong artist'; END IF;
 IF NOT EXISTS (SELECT 1 FROM "Revision" WHERE "orderId"=1 AND "openedAt"='2026-01-01' AND "messageId" IS NULL) THEN RAISE EXCEPTION 'legacy data lost'; END IF;
END $$;
UPDATE "BluesalesOrderInfo" SET "orderStatusId"=174704 WHERE "orderId"=1;
UPDATE "BluesalesOrderInfo" SET "orderStatusId"=179918 WHERE "orderId"=1;
UPDATE "BluesalesOrderInfo" SET "orderStatusId"=174704 WHERE "orderId"=1;
DO $$ BEGIN
 IF (SELECT count(*) FROM "Revision" WHERE "orderId"=1) <> 2 THEN RAISE EXCEPTION 're-entry duplicates active cycle'; END IF;
END $$;
UPDATE "BluesalesOrderInfo" SET "orderStatusId"=179920 WHERE "orderId"=1;
DO $$ BEGIN
 IF (SELECT count(*) FROM "RevisionClosure") <> 3 THEN RAISE EXCEPTION 'second cycle not closed'; END IF;
END $$;
-- Removing an artist clears attribution without deleting historical closures.
UPDATE "Order" SET "revisionDesignerId"=NULL WHERE "revisionDesignerId"=1;
DELETE FROM "User" WHERE id=1;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM "RevisionClosure" WHERE "closedById" IS NOT NULL) THEN RAISE EXCEPTION 'artist FK must SET NULL'; END IF;
 IF (SELECT count(*) FROM "RevisionClosure") <> 3 THEN RAISE EXCEPTION 'deleting artist lost history'; END IF;
END $$;
-- A newly imported order starts a cycle without a message.
INSERT INTO "Order" VALUES (5,NULL);
INSERT INTO "BluesalesOrderInfo" VALUES (5,174704,NULL);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM "Revision" WHERE "orderId"=5 AND "messageId" IS NULL) THEN RAISE EXCEPTION 'import did not open cycle'; END IF;
END $$;
-- Status and revision effects roll back together on transaction failure.
BEGIN;
UPDATE "BluesalesOrderInfo" SET "orderStatusId"=179920 WHERE "orderId"=5;
ROLLBACK;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM "RevisionClosure" c JOIN "Revision" r ON r.id=c."revisionId" WHERE r."orderId"=5) THEN RAISE EXCEPTION 'closure escaped rolled back status'; END IF;
END $$;
DROP SCHEMA revision_fixture CASCADE;
\echo 'Revision migration and lifecycle fixtures passed'
