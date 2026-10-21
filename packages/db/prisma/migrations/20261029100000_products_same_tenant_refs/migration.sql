-- products.category_id and products.supplier_id must point at a row of the SAME business.
--
-- The ordinary foreign keys only prove the row exists: the check they run ignores row-level security, so a product of
-- business A could be pointed at a category of business B if the application ever forgot to check (today it does check).
-- A composite foreign key (tenant_id, category_id) would be the textbook fix, but Prisma cannot express a composite key
-- whose second column is nullable, and a key it does not know about is dropped by the next `prisma migrate dev`. A trigger
-- is not diffed by Prisma, and it runs as the caller, so RLS applies to its lookup as well: another business's row is
-- neither visible nor the same tenant, and either condition is enough to refuse.

-- 1. Data check first. Nothing may be changed silently: if a bad pair exists the migration stops and says how many.
DO $$
DECLARE
  bad_categories integer;
  bad_suppliers integer;
BEGIN
  SELECT count(*) INTO bad_categories
    FROM products p JOIN categories c ON c.id = p.category_id
   WHERE p.category_id IS NOT NULL AND c.tenant_id <> p.tenant_id;
  SELECT count(*) INTO bad_suppliers
    FROM products p JOIN suppliers s ON s.id = p.supplier_id
   WHERE p.supplier_id IS NOT NULL AND s.tenant_id <> p.tenant_id;
  IF bad_categories > 0 OR bad_suppliers > 0 THEN
    RAISE EXCEPTION 'products point at another business''s category (%) or supplier (%): fix these rows (set the column to NULL) and run the migration again',
      bad_categories, bad_suppliers;
  END IF;
END $$;

-- 2. The guard.
CREATE FUNCTION products_same_tenant_refs() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  IF NEW.category_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM categories c WHERE c.id = NEW.category_id AND c.tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'category % does not belong to this business', NEW.category_id
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'products_category_same_tenant';
  END IF;
  IF NEW.supplier_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM suppliers s WHERE s.id = NEW.supplier_id AND s.tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'supplier % does not belong to this business', NEW.supplier_id
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'products_supplier_same_tenant';
  END IF;
  RETURN NEW;
END
$$;

-- Only when one of the two columns is written, so ordinary product edits pay nothing.
CREATE TRIGGER products_same_tenant_refs
  BEFORE INSERT OR UPDATE OF tenant_id, category_id, supplier_id ON products
  FOR EACH ROW EXECUTE FUNCTION products_same_tenant_refs();
