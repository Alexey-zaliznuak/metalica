-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "email" TEXT;

-- CreateIndex
CREATE INDEX "Lead_email_idx" ON "Lead"("email");

-- Bootstrap from already stored order responses, without any BlueSales requests.
-- Partial customer responses without an email must not erase known addresses.
WITH emails AS (
    SELECT DISTINCT ON ("bsCustomerId") "bsCustomerId",
           lower(btrim("rawPayload" #>> '{customer,email}')) AS email
    FROM "BluesalesOrderInfo"
    WHERE "bsCustomerId" IS NOT NULL
      AND jsonb_typeof("rawPayload" #> '{customer,email}') = 'string'
      AND btrim("rawPayload" #>> '{customer,email}') <> ''
    ORDER BY "bsCustomerId", "lastSyncedAt" DESC, "id" DESC
)
UPDATE "Lead" AS lead SET "email" = emails.email
FROM emails WHERE lead."bsCustomerId" = emails."bsCustomerId" AND lead."email" IS NULL;

WITH emails AS (
    SELECT DISTINCT ON ("bsCustomerId") "bsCustomerId",
           lower(btrim("snapshot" #>> '{customer,email}')) AS email
    FROM "MetavistaOrder"
    WHERE "bsCustomerId" IS NOT NULL
      AND jsonb_typeof("snapshot" #> '{customer,email}') = 'string'
      AND btrim("snapshot" #>> '{customer,email}') <> ''
    ORDER BY "bsCustomerId", "updatedAt" DESC, "externalId"
)
UPDATE "Lead" AS lead SET "email" = emails.email
FROM emails WHERE lead."bsCustomerId" = emails."bsCustomerId" AND lead."email" IS NULL;
