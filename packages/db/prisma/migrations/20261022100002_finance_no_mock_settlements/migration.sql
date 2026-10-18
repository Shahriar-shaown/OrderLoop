-- The simulated courier moves no money, so it has no settlements.
ALTER TABLE settlement_batches ADD CONSTRAINT settlement_batches_not_simulated CHECK (provider <> 'mock');
