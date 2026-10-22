-- Data deletion (docs/privacy-and-deletion.md): erase one customer's personal data, delete a person's account, delete a whole
-- business after a grace period. These are technical capabilities, not a statement about any law.
--
-- Orders, shipments, settlements, the stock ledger and the audit log are append-only for the runtime role (app_user) on purpose,
-- so none of this can be done with ordinary statements. Each operation below is a narrow SECURITY DEFINER function owned by the
-- migration role (the pattern of stale_pending_imports and purge_social_data); the runtime role can run only the functions
-- granted to it at the bottom, and each one checks its own preconditions:
--   erase_customer(tenant, customer, ...)  only for the tenant the caller's transaction is already scoped to (app.tenant_id)
--   delete_own_account(user)               only for the user the caller's transaction is scoped to (app.user_id)
--   tenants_due_for_purge / purge_tenant   only for a business that was asked to be deleted and whose grace period is over
-- The helpers (erasure_*, _anonymise_user) are not granted to anyone.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN deleted_at timestamptz(3);

ALTER TABLE tenants
  ADD COLUMN deletion_requested_at timestamptz(3),
  ADD COLUMN purge_after timestamptz(3),
  ADD COLUMN deletion_requested_by_id uuid,
  ADD CONSTRAINT tenants_deletion_consistent CHECK ((deletion_requested_at IS NULL) = (purge_after IS NULL));

ALTER TABLE customers ADD COLUMN erased_at timestamptz(3);

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Owner-only policies, for the definer functions. app_user is not the owner, so none of these applies to it.
-- ---------------------------------------------------------------------------------------------------------------------
-- The purge deletes a business's audit trail with the business (it runs with app.tenant_id set to that business).
CREATE POLICY purge_owner_delete ON audit_logs FOR DELETE TO CURRENT_USER USING (tenant_id = app_current_tenant());
-- Deleting an account removes the IP address from the audit rows that person's actions left, in every business.
CREATE POLICY anonymise_owner_select ON audit_logs FOR SELECT TO CURRENT_USER USING (actor_user_id IS NOT NULL);
CREATE POLICY anonymise_owner_update ON audit_logs FOR UPDATE TO CURRENT_USER USING (actor_user_id IS NOT NULL) WITH CHECK (actor_user_id IS NOT NULL);

-- The stock ledger has an insert and a select policy only. Erasing a customer redacts the free-text reason of their movements,
-- and the purge deletes a business's ledger: both confined to the business the function is scoped to.
CREATE POLICY erase_owner_update ON stock_movements FOR UPDATE TO CURRENT_USER
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY purge_owner_delete ON stock_movements FOR DELETE TO CURRENT_USER USING (tenant_id = app_current_tenant());

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Text helpers (not granted)
-- ---------------------------------------------------------------------------------------------------------------------
-- A regular expression that matches any of the needles literally, or NULL when there is none.
CREATE FUNCTION erasure_pattern(needles text[]) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT '(' || string_agg(regexp_replace(n, '([.^$|?*+()\[\]{}\\])', '\\\1', 'g'), '|') || ')'
  FROM unnest(needles) AS n
  WHERE n IS NOT NULL AND length(n) > 0
$$;

-- `t` with every needle replaced by [erased] (case-insensitive).
CREATE FUNCTION erasure_scrub_text(t text, pattern text) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE WHEN t IS NULL OR pattern IS NULL THEN t ELSE regexp_replace(t, pattern, '[erased]', 'gi') END
$$;

-- A JSON document with the needles replaced in every string. With `redact_keys`, values under keys that name a person
-- (name, phone, address, recipient, customer, email, contact, note) are replaced whole: used for what a courier or a statement
-- file sent about one delivery, where the field names are the courier's and the values may be spelled differently.
CREATE FUNCTION erasure_scrub_json(j jsonb, pattern text, redact_keys boolean) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  k text;
  v jsonb;
  result jsonb;
BEGIN
  CASE jsonb_typeof(j)
    WHEN 'object' THEN
      result := '{}'::jsonb;
      FOR k, v IN SELECT * FROM jsonb_each(j) LOOP
        IF redact_keys AND jsonb_typeof(v) IN ('string', 'number')
           AND k ~* '(name|phone|mobile|msisdn|address|recipient|customer|email|contact|note)' THEN
          result := result || jsonb_build_object(k, '[erased]');
        ELSE
          result := result || jsonb_build_object(k, erasure_scrub_json(v, pattern, redact_keys));
        END IF;
      END LOOP;
      RETURN result;
    WHEN 'array' THEN
      SELECT COALESCE(jsonb_agg(erasure_scrub_json(e.value, pattern, redact_keys) ORDER BY e.ord), '[]'::jsonb)
        INTO result
        FROM jsonb_array_elements(j) WITH ORDINALITY AS e(value, ord);
      RETURN result;
    WHEN 'string' THEN
      RETURN to_jsonb(erasure_scrub_text(j #>> '{}', pattern));
    ELSE
      RETURN j;
  END CASE;
END
$$;

-- The spellings of a phone number free text may hold: 8801712345678 and 01712345678 (a leading + is left over harmlessly).
CREATE FUNCTION erasure_phone_forms(p text) RETURNS text[]
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN length(regexp_replace(COALESCE(p, ''), '\D', '', 'g')) < 10 THEN ARRAY[]::text[]
    WHEN regexp_replace(p, '\D', '', 'g') LIKE '880%'
      THEN ARRAY[regexp_replace(p, '\D', '', 'g'), '0' || substr(regexp_replace(p, '\D', '', 'g'), 4)]
    ELSE ARRAY[regexp_replace(p, '\D', '', 'g')]
  END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Customer erasure
-- ---------------------------------------------------------------------------------------------------------------------
-- outcome: 'erased' | 'already' | 'blocked' | 'missing'. `blocking_orders` counts orders still in progress (the caller refuses then).
-- `change_counts` says what changed (numbers only). `clean_reason` is the caller's reason with the customer's own details taken out.
CREATE FUNCTION erase_customer(p_tenant uuid, p_customer uuid, p_reason text DEFAULT NULL)
RETURNS TABLE (outcome text, erased_on timestamptz, order_count integer, blocking_orders integer, change_counts jsonb, clean_reason text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  c customers%ROWTYPE;
  needles text[];
  pattern text;
  n_orders integer;
  n_blocking integer;
  n_addresses integer := 0;
  n_settlement integer := 0;
  n_drafts integer := 0;
  n_events integer := 0;
  n_keys integer := 0;
  n_texts integer := 0;
  n integer;
  pairs text[];
  spec text[];
  one text;
  specs text[] := ARRAY[
    'orders.notes', 'order_status_history.reason', 'manual_costs.note', 'manual_costs.void_reason',
    'discrepancies.message', 'discrepancies.resolution', 'stock_movements.reason', 'settlement_items.note',
    'settlement_items.match_note', 'settlement_item_events.note', 'shipments.failure_reason', 'shipment_events.note',
    'notifications.title', 'notifications.body', 'automation_runs.error', 'notification_deliveries.last_error',
    'import_jobs.csv', 'customers.notes'];
  jsons text[] := ARRAY[
    'shipment_events.payload', 'settlement_items.raw', 'settlement_item_events.data', 'notifications.data',
    'import_jobs.errors'];
  placeholder text := 'erased';
BEGIN
  -- Only inside the business the transaction is already scoped to: the same fence row-level security gives every query.
  IF p_tenant IS NULL OR p_tenant IS DISTINCT FROM app_current_tenant() THEN
    RAISE EXCEPTION 'erase_customer: the transaction is not scoped to this business' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO c FROM customers WHERE tenant_id = p_tenant AND id = p_customer FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'missing'::text, NULL::timestamptz, 0, 0, '{}'::jsonb, NULL::text;
    RETURN;
  END IF;
  SELECT count(*)::integer INTO n_orders FROM orders WHERE tenant_id = p_tenant AND customer_id = p_customer;
  IF c.erased_at IS NOT NULL THEN
    RETURN QUERY SELECT 'already'::text, c.erased_at, n_orders, 0, '{}'::jsonb, NULL::text;
    RETURN;
  END IF;

  SELECT count(*)::integer INTO n_blocking FROM orders
   WHERE tenant_id = p_tenant AND customer_id = p_customer AND status NOT IN ('delivered', 'cancelled', 'returned');
  IF n_blocking > 0 THEN
    RETURN QUERY SELECT 'blocked'::text, NULL::timestamptz, n_orders, n_blocking, '{}'::jsonb, NULL::text;
    RETURN;
  END IF;

  -- What identifies this person, in every spelling we hold: free text elsewhere in the business is scrubbed for these.
  SELECT array_agg(DISTINCT x) INTO needles FROM (
    SELECT unnest(erasure_phone_forms(c.phone)) AS x
    UNION SELECT unnest(erasure_phone_forms(o.ship_phone)) FROM orders o WHERE o.tenant_id = p_tenant AND o.customer_id = p_customer
    UNION SELECT unnest(erasure_phone_forms(a.phone)) FROM customer_addresses a WHERE a.tenant_id = p_tenant AND a.customer_id = p_customer
    UNION SELECT c.email WHERE c.email IS NOT NULL
    UNION SELECT c.name WHERE length(c.name) >= 4
    UNION SELECT o.ship_name FROM orders o WHERE o.tenant_id = p_tenant AND o.customer_id = p_customer AND length(o.ship_name) >= 4
    UNION SELECT a.recipient_name FROM customer_addresses a WHERE a.tenant_id = p_tenant AND a.customer_id = p_customer AND length(a.recipient_name) >= 4
    UNION SELECT o.ship_line1 FROM orders o WHERE o.tenant_id = p_tenant AND o.customer_id = p_customer AND length(o.ship_line1) >= 8
    UNION SELECT a.line1 FROM customer_addresses a WHERE a.tenant_id = p_tenant AND a.customer_id = p_customer AND length(a.line1) >= 8
  ) s WHERE x IS NOT NULL AND lower(x) NOT IN ('erased', 'erased customer');
  pattern := erasure_pattern(COALESCE(needles, ARRAY[]::text[]));

  -- Meta: the drafts of this customer's orders, drafts that quote the number, and the conversations they came from.
  WITH gone AS (
    DELETE FROM social_drafts d
     WHERE d.tenant_id = p_tenant
       AND (d.order_id IN (SELECT o.id FROM orders o WHERE o.tenant_id = p_tenant AND o.customer_id = p_customer)
            OR (pattern IS NOT NULL AND (d.extracted::text || ' ' || d.overrides::text) ~* pattern))
    RETURNING d.connection_id, d.sender_id)
  SELECT count(*)::integer, COALESCE(array_agg(DISTINCT gone.connection_id::text || '|' || gone.sender_id), ARRAY[]::text[])
    INTO n_drafts, pairs FROM gone;
  WITH gone AS (
    DELETE FROM social_events e
     WHERE e.tenant_id = p_tenant
       AND ((e.connection_id::text || '|' || e.sender_id) = ANY (pairs)
            OR (pattern IS NOT NULL AND e.payload::text ~* pattern))
    RETURNING 1)
  SELECT count(*)::integer INTO n_events FROM gone;

  -- What a courier's statement said about this person's deliveries (the amounts stay: finance must still add up).
  WITH mine AS (
    SELECT s.id FROM settlement_items s
     WHERE s.tenant_id = p_tenant
       AND (s.order_id IN (SELECT o.id FROM orders o WHERE o.tenant_id = p_tenant AND o.customer_id = p_customer)
            OR s.shipment_id IN (SELECT sh.id FROM shipments sh JOIN orders o ON o.tenant_id = sh.tenant_id AND o.id = sh.order_id
                                  WHERE sh.tenant_id = p_tenant AND o.customer_id = p_customer)
            OR (pattern IS NOT NULL AND s.phone IS NOT NULL AND s.phone ~* pattern)))
  UPDATE settlement_items s
     SET phone = NULL,
         raw = erasure_scrub_json(s.raw, pattern, true),
         updated_at = now()
    FROM mine WHERE s.tenant_id = p_tenant AND s.id = mine.id;
  GET DIAGNOSTICS n_settlement = ROW_COUNT;

  -- What a courier sent about this person's shipments.
  UPDATE shipment_events e
     SET payload = erasure_scrub_json(e.payload, pattern, true)
   WHERE e.tenant_id = p_tenant AND e.payload IS NOT NULL
     AND e.shipment_id IN (SELECT sh.id FROM shipments sh JOIN orders o ON o.tenant_id = sh.tenant_id AND o.id = sh.order_id
                            WHERE sh.tenant_id = p_tenant AND o.customer_id = p_customer);

  -- The copies on the orders: name, phone, address text and the notes. Money, status, ids and dates stay.
  UPDATE orders
     SET ship_name = 'Erased customer', ship_phone = placeholder, ship_line1 = 'Erased', ship_area = 'Erased',
         ship_postal_code = NULL, notes = NULL, source_reference = NULL, updated_at = now()
   WHERE tenant_id = p_tenant AND customer_id = p_customer;

  DELETE FROM customer_addresses WHERE tenant_id = p_tenant AND customer_id = p_customer;
  GET DIAGNOSTICS n_addresses = ROW_COUNT;

  UPDATE customers
     SET name = 'Erased customer', name_key = 'erased customer', phone = 'erased-' || p_customer::text,
         email = NULL, notes = NULL, erased_at = now(), updated_at = now()
   WHERE tenant_id = p_tenant AND id = p_customer
   RETURNING customers.erased_at INTO c.erased_at;

  -- Free text anywhere else in the business that quotes the name or number (a status reason, a cost note, a notification, a
  -- failed CSV import). Only exact spellings are found: see docs/privacy-and-deletion.md for what this cannot catch.
  IF pattern IS NOT NULL THEN
    FOREACH one IN ARRAY specs LOOP
      spec := string_to_array(one, '.');
      EXECUTE format('UPDATE %I SET %I = erasure_scrub_text(%I, $2) WHERE tenant_id = $1 AND %I ~* $2',
                     spec[1], spec[2], spec[2], spec[2]) USING p_tenant, pattern;
      GET DIAGNOSTICS n = ROW_COUNT;
      n_texts := n_texts + n;
    END LOOP;
    FOREACH one IN ARRAY jsons LOOP
      spec := string_to_array(one, '.');
      EXECUTE format('UPDATE %I SET %I = erasure_scrub_json(%I, $2, false) WHERE tenant_id = $1 AND %I::text ~* $2',
                     spec[1], spec[2], spec[2], spec[2]) USING p_tenant, pattern;
      GET DIAGNOSTICS n = ROW_COUNT;
      n_texts := n_texts + n;
    END LOOP;
    -- A stored answer to a repeated request (create customer, create order, ...) holds the details it was given: drop it.
    DELETE FROM idempotency_keys k
     WHERE k.tenant_id = p_tenant AND (k.response_body::text ~* pattern OR k.response_body::text LIKE '%' || p_customer::text || '%');
    GET DIAGNOSTICS n_keys = ROW_COUNT;
  ELSE
    DELETE FROM idempotency_keys k WHERE k.tenant_id = p_tenant AND k.response_body::text LIKE '%' || p_customer::text || '%';
    GET DIAGNOSTICS n_keys = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT
    'erased'::text, c.erased_at, n_orders, 0,
    jsonb_build_object('orders', n_orders, 'addresses', n_addresses, 'settlementItems', n_settlement,
                       'socialDrafts', n_drafts, 'socialEvents', n_events, 'textsScrubbed', n_texts,
                       'idempotencyKeys', n_keys),
    erasure_scrub_text(left(p_reason, 300), pattern);
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Account deletion
-- ---------------------------------------------------------------------------------------------------------------------
-- The person's row stays (orders, audit and ledger rows refer to its id) but holds nothing that identifies them, cannot be
-- signed in to, and no longer owns its email address, so the address can register again. Not granted: delete_own_account and
-- purge_tenant call it.
CREATE FUNCTION _anonymise_user(p_user uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- The user-scoped tables are fenced by app.user_id like everything else.
  PERFORM set_config('app.user_id', p_user::text, true);
  UPDATE users
     SET email = 'deleted-' || id::text || '@deleted.invalid', name = 'Deleted user', password_hash = '',
         email_verified_at = NULL, disabled_at = COALESCE(disabled_at, now()), deleted_at = COALESCE(deleted_at, now())
   WHERE id = p_user;
  DELETE FROM sessions WHERE user_id = p_user;       -- refresh tokens go with their session
  DELETE FROM user_tokens WHERE user_id = p_user;
  DELETE FROM push_devices WHERE user_id = p_user;
  DELETE FROM idempotency_keys WHERE tenant_id IS NULL AND user_id = p_user;
  UPDATE audit_logs SET ip = NULL WHERE actor_user_id = p_user AND ip IS NOT NULL;
END
$$;
REVOKE ALL ON FUNCTION _anonymise_user(uuid) FROM PUBLIC;

CREATE FUNCTION delete_own_account(p_user uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_user IS NULL OR p_user IS DISTINCT FROM app_current_user() THEN
    RAISE EXCEPTION 'delete_own_account: the transaction is not scoped to this user' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM memberships WHERE user_id = p_user) THEN
    RAISE EXCEPTION 'delete_own_account: the person still belongs to a business' USING ERRCODE = '23503';
  END IF;
  PERFORM _anonymise_user(p_user);
END
$$;
REVOKE ALL ON FUNCTION delete_own_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_own_account(uuid) TO app_user;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Business purge (worker)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION tenants_due_for_purge(max_rows integer DEFAULT 20)
RETURNS TABLE (id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT t.id FROM tenants t
  WHERE t.purge_after IS NOT NULL AND t.purge_after <= now()
  ORDER BY t.purge_after, t.id
  LIMIT LEAST(GREATEST(max_rows, 1), 100)
$$;
REVOKE ALL ON FUNCTION tenants_due_for_purge(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenants_due_for_purge(integer) TO app_user;

-- Deletes the business and every row under it, children first (a composite foreign key is RESTRICT, so the order matters; the
-- last statement is the business itself, which would cascade over anything this list ever misses). Refuses a business that
-- was not asked to be deleted or whose grace period has not ended, so nothing the runtime role can pass in deletes a live one.
-- The person who asked, if that leaves them with no business at all, is anonymised like a deleted account (nobody else is touched).
CREATE FUNCTION purge_tenant(p_tenant uuid)
RETURNS TABLE (purged boolean, rows_deleted integer, counts jsonb, user_anonymised boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  requested_by uuid;
  tbl text;
  n integer;
  total integer := 0;
  per jsonb := '{}'::jsonb;
  anonymised boolean := false;
  -- Order matters: every table appears before the tables it references.
  tables text[] := ARRAY[
    'notification_deliveries', 'notifications', 'notification_preferences', 'messaging_consents',
    'social_oauth_sessions', 'social_drafts', 'social_events', 'social_connections',
    'automation_state', 'automation_runs', 'automation_rules',
    'settlement_item_events', 'discrepancies', 'settlement_items', 'settlement_batches',
    'manual_costs', 'shipment_events', 'shipments', 'courier_connections',
    'order_status_history', 'order_items', 'order_counters', 'orders', 'customer_addresses', 'customers',
    'stock_movements', 'reservations', 'stock_levels', 'product_variants', 'products', 'suppliers', 'categories',
    'stock_locations', 'import_jobs', 'idempotency_keys', 'invitations', 'memberships', 'audit_logs'];
BEGIN
  -- Fence the session to this business, as the API would, so row-level security lets the deletes through (and only these).
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  SELECT t.deletion_requested_by_id INTO requested_by
    FROM tenants t
   WHERE t.id = p_tenant AND t.purge_after IS NOT NULL AND t.purge_after <= now()
   FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM set_config('app.tenant_id', '', true);
    RETURN QUERY SELECT false, 0, '{}'::jsonb, false;
    RETURN;
  END IF;

  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', tbl) USING p_tenant;
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
    IF n > 0 THEN per := per || jsonb_build_object(tbl, n); END IF;
  END LOOP;
  -- A stored answer to "create a business" belongs to the person, not the business, and names it.
  DELETE FROM idempotency_keys
   WHERE tenant_id IS NULL AND response_body ->> 'id' = p_tenant::text AND created_at < now() - interval '1 hour';
  DELETE FROM sessions WHERE active_tenant_id = p_tenant;
  DELETE FROM tenants WHERE id = p_tenant;
  total := total + 1;

  IF requested_by IS NOT NULL THEN
    PERFORM set_config('app.user_id', requested_by::text, true);
    IF NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = requested_by)
       AND EXISTS (SELECT 1 FROM users WHERE id = requested_by AND deleted_at IS NULL) THEN
      PERFORM _anonymise_user(requested_by);
      anonymised := true;
    END IF;
  END IF;

  -- The business's own audit trail went with it; one tenant-less line (ids and numbers only) records that it happened.
  PERFORM set_config('app.tenant_id', '', true);
  INSERT INTO audit_logs (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (gen_random_uuid(), NULL, requested_by, 'tenant.purged', 'tenant', p_tenant::text,
          jsonb_build_object('rows', total, 'userAnonymised', anonymised));
  PERFORM set_config('app.user_id', '', true);
  RETURN QUERY SELECT true, total, per, anonymised;
END
$$;
REVOKE ALL ON FUNCTION purge_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_tenant(uuid) TO app_user;

REVOKE ALL ON FUNCTION erase_customer(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erase_customer(uuid, uuid, text) TO app_user;
REVOKE ALL ON FUNCTION erasure_pattern(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION erasure_scrub_text(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION erasure_scrub_json(jsonb, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION erasure_phone_forms(text) FROM PUBLIC;
