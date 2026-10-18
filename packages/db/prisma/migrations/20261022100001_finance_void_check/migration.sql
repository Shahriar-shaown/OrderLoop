-- A cost is voided completely (when, by whom, why) or not at all.
ALTER TABLE manual_costs DROP CONSTRAINT manual_costs_void_complete;
ALTER TABLE manual_costs ADD CONSTRAINT manual_costs_void_complete CHECK (
  (voided_at IS NULL AND voided_by_id IS NULL AND void_reason IS NULL) OR
  (voided_at IS NOT NULL AND voided_by_id IS NOT NULL AND void_reason IS NOT NULL));
