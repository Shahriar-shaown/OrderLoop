
-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "seq" BIGSERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_seq_key" ON "stock_movements"("seq");


-- The runtime role inserts ledger rows, so it needs the sequence behind `seq`.
GRANT USAGE, SELECT ON SEQUENCE stock_movements_seq_seq TO app_user;
