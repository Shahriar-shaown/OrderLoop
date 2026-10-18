-- New ledger movement types. Kept in their own migration: Postgres cannot use a new enum value in the transaction
-- that adds it, and the next migration's CHECK constraint names them.
ALTER TYPE "StockMovementType" ADD VALUE 'DAMAGE';
ALTER TYPE "StockMovementType" ADD VALUE 'WRITE_OFF';
ALTER TYPE "StockMovementType" ADD VALUE 'RETURN';
