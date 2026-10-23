ALTER TABLE "transactions" ADD COLUMN "sourceTransactionId" TEXT;
ALTER TABLE "transactions" ADD COLUMN "scheduledFor" TIMESTAMP(3);
ALTER TABLE "budgets" ADD COLUMN "alertClaimedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "transactions_sourceTransactionId_scheduledFor_key"
  ON "transactions"("sourceTransactionId", "scheduledFor");
CREATE INDEX "transactions_userId_date_idx" ON "transactions"("userId", "date");
CREATE INDEX "transactions_accountId_date_idx" ON "transactions"("accountId", "date");

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "userId" ORDER BY "updatedAt" DESC, id DESC) AS position
  FROM "accounts" WHERE "isDefault" = true
)
UPDATE "accounts" SET "isDefault" = false
WHERE id IN (SELECT id FROM ranked WHERE position > 1);

WITH ranked AS (
  SELECT id, "userId", ROW_NUMBER() OVER (PARTITION BY "userId" ORDER BY "createdAt", id) AS position
  FROM "accounts"
)
UPDATE "accounts" SET "isDefault" = true
WHERE id IN (
  SELECT ranked.id FROM ranked
  WHERE ranked.position = 1 AND NOT EXISTS (
    SELECT 1 FROM "accounts" existing
    WHERE existing."userId" = ranked."userId" AND existing."isDefault" = true
  )
);

CREATE UNIQUE INDEX "accounts_one_default_per_user"
  ON "accounts"("userId") WHERE "isDefault" = true;
