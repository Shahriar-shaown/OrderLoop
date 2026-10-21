import { describe, expect, it } from 'vitest';
import { RegisterBody } from './auth.js';
import { buildOpenApiDocument } from './openapi.js';
import { routes } from './routes.js';

describe('route registry', () => {
  it('has unique operation ids and unique method+path pairs', () => {
    const specs = Object.values(routes);
    expect(new Set(specs.map((s) => s.id)).size).toBe(specs.length);
    expect(new Set(specs.map((s) => `${s.method} ${s.path}`)).size).toBe(specs.length);
  });

  it('keys match operation ids', () => {
    for (const [key, spec] of Object.entries(routes)) expect(spec.id).toBe(key);
  });

  it('every access route that is not self-service declares a permission or is intentionally open to any member', () => {
    // Self-service: they act on the caller's own session, preferences or memberships, never on business data.
    const openToAnyMember = new Set([
      'logout',
      'switchTenant',
      'me',
      'updatePreferences',
      'listWorkspaces',
      'createWorkspace',
      'resendVerification',
      // Notifications belong to the person, not to the business's data: any member lists and reads their own.
      'listNotifications',
      'getUnreadNotificationCount',
      'markNotificationRead',
      'markAllNotificationsRead',
      'getNotificationPreferences',
      'updateNotificationPreferences',
      'registerPushDevice',
      'removePushDevice',
      'getMessagingConsents',
      'updateMessagingConsent',
    ]);
    for (const spec of Object.values(routes)) {
      if (spec.auth === 'access' && !openToAnyMember.has(spec.id))
        expect('permission' in spec).toBe(true);
    }
  });
});

describe('openapi', () => {
  const doc = buildOpenApiDocument({ title: 'OrderLoop API', version: '0.0.0' });
  it('documents every route', () => {
    const ops = Object.values(doc.paths).flatMap(
      (p) => Object.values(p) as { operationId: string }[],
    );
    expect(ops.map((o) => o.operationId).sort()).toEqual(Object.keys(routes).sort());
  });
  it('converts path params and marks them required', () => {
    const op = doc.paths['/v1/members/{id}']!['patch'] as {
      parameters: { name: string; in: string; required: boolean }[];
    };
    expect(op.parameters).toContainEqual(
      expect.objectContaining({ name: 'id', in: 'path', required: true }),
    );
  });
});

describe('display names', () => {
  const base = { email: 'a@b.test', password: 'Long enough password 1!', tenantName: 'Shop' };
  it('accept ordinary names, including non-Latin scripts', () => {
    for (const name of ['Ann Lee', 'আনিকা রহমান', "O'Brien-Smith"])
      expect(RegisterBody.safeParse({ ...base, name }).success, name).toBe(true);
  });
  it('reject line breaks, control characters and invisible formatting characters', () => {
    for (const name of [
      'Ann\nClick here',
      'Ann\u0000',
      'Ann\u200bLee',
      'Ann\u202eLee',
      'a\u2028b',
    ]) {
      expect(RegisterBody.safeParse({ ...base, name }).success, JSON.stringify(name)).toBe(false);
    }
  });
});

describe('catalog schemas', () => {
  const variant = { sku: 'tee-1', priceMinor: 1000 };
  it('normalise SKUs and apply defaults', async () => {
    const { ProductBody } = await import('./catalog.js');
    const parsed = ProductBody.parse({ name: ' Mug ', variants: [variant] });
    expect(parsed).toMatchObject({ name: 'Mug', unit: 'pcs' });
    expect(parsed.variants[0]).toMatchObject({
      sku: 'TEE-1',
      name: '',
      attributes: {},
      reorderPoint: 0,
    });
  });
  it('money is integer paisa within range', async () => {
    const { VariantInput } = await import('./catalog.js');
    for (const priceMinor of [1.5, -1, 2_000_000_001, Number.NaN, '100'])
      expect(VariantInput.safeParse({ ...variant, priceMinor }).success, String(priceMinor)).toBe(
        false,
      );
    expect(VariantInput.safeParse({ ...variant, priceMinor: 0 }).success).toBe(true);
  });
  it('a product needs 1 to 50 variants and a known unit', async () => {
    const { ProductBody } = await import('./catalog.js');
    expect(ProductBody.safeParse({ name: 'X', variants: [] }).success).toBe(false);
    expect(
      ProductBody.safeParse({
        name: 'X',
        variants: Array.from({ length: 51 }, (_, i) => ({ sku: `S${i}`, priceMinor: 1 })),
      }).success,
    ).toBe(false);
    expect(ProductBody.safeParse({ name: 'X', unit: 'furlong', variants: [variant] }).success).toBe(
      false,
    );
  });
  it('stock bodies bound quantities, require a reason for adjustments, and reject zero deltas', async () => {
    const { ReceiveBody, AdjustBody, ReservationBody } = await import('./catalog.js');
    const id = '0197b0a0-0000-7000-8000-000000000001';
    expect(ReceiveBody.safeParse({ variantId: id, quantity: 1_000_000 }).success).toBe(true);
    for (const quantity of [0, -1, 1.5, 1_000_001])
      expect(ReceiveBody.safeParse({ variantId: id, quantity }).success, String(quantity)).toBe(
        false,
      );
    expect(AdjustBody.safeParse({ variantId: id, delta: 0, reason: 'recount' }).success).toBe(
      false,
    );
    expect(AdjustBody.safeParse({ variantId: id, delta: -3 }).success).toBe(false);
    expect(AdjustBody.safeParse({ variantId: id, delta: -3, reason: 'ok' }).success).toBe(false); // too short to be a reason
    expect(
      AdjustBody.safeParse({ variantId: id, delta: -3, reason: 'damaged in transit' }).success,
    ).toBe(true);
    expect(
      ReservationBody.safeParse({ variantId: id, quantity: 1, idempotencyKey: 'short' }).success,
    ).toBe(false);
    expect(
      ReservationBody.safeParse({
        variantId: id,
        quantity: 1,
        idempotencyKey: 'order-1234-reserve',
      }).success,
    ).toBe(true);
  });
  it('every inventory and catalog route declares a permission', async () => {
    const { routes } = await import('./routes.js');
    const protectedPaths = Object.values(routes).filter((r) =>
      /^\/v1\/(products|categories|variants|locations|inventory|reservations|imports)/.test(r.path),
    );
    expect(protectedPaths.length).toBeGreaterThan(20);
    for (const r of protectedPaths) expect('permission' in r, r.id).toBe(true);
  });
});
