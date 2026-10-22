import { CourierError, type CourierAdapter } from '@orderloop/courier-sdk';

export type Provider = 'pathao' | 'steadfast';
export type Status = 'PASS' | 'FAIL' | 'SKIP' | 'N/A';

export interface VerifyArgs {
  provider: Provider;
  /** Pathao only. Default sandbox. */
  environment: 'sandbox' | 'production';
  /** Steadfast only. Default steadfast. */
  host: 'steadfast' | 'packzy';
  /** A consignment id (tracking lookup). */
  consignment?: string | undefined;
  /** Our own reference / Steadfast invoice (lookup by reference). */
  reference?: string | undefined;
  cityId?: number | undefined;
  zoneId?: number | undefined;
  storeId?: number | undefined;
}

/** Credentials are read from these variables ONLY (never from arguments, never from a file this tool writes). */
export const CREDENTIAL_ENV = {
  pathao: {
    clientId: 'COURIER_VERIFY_PATHAO_CLIENT_ID',
    clientSecret: 'COURIER_VERIFY_PATHAO_CLIENT_SECRET',
    username: 'COURIER_VERIFY_PATHAO_USERNAME',
    password: 'COURIER_VERIFY_PATHAO_PASSWORD',
  },
  steadfast: {
    apiKey: 'COURIER_VERIFY_STEADFAST_API_KEY',
    secretKey: 'COURIER_VERIFY_STEADFAST_SECRET_KEY',
  },
} as const;

const FORBIDDEN = new Set([
  '--book',
  '--cancel',
  '--create',
  '--delete',
  '--send',
  '--client-id',
  '--client-secret',
  '--username',
  '--password',
  '--api-key',
  '--secret-key',
  '--token',
]);

const REFERENCE_RE = /^[A-Za-z0-9_-]{1,100}$/;
const positiveInt = (name: string, v: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive whole number`);
  return n;
};

/**
 * `pnpm courier:verify -- --provider pathao|steadfast [--environment sandbox|production] [--host steadfast|packzy]
 * [--consignment <id>] [--reference <ref>] [--city-id n] [--zone-id n] [--store-id n]`. Strict: an unknown flag is refused, and
 * so are flags that would book, cancel or carry a credential on the command line.
 */
export function parseVerifyArgs(argv: string[]): VerifyArgs {
  const args = argv.filter((a) => a !== '--');
  const out: Partial<VerifyArgs> = { environment: 'sandbox', host: 'steadfast' };
  for (let i = 0; i < args.length; i++) {
    let flag = args[i]!;
    let inline: string | undefined;
    const eq = flag.indexOf('=');
    if (flag.startsWith('--') && eq > 0) {
      inline = flag.slice(eq + 1);
      flag = flag.slice(0, eq);
    }
    if (FORBIDDEN.has(flag)) {
      throw new Error(
        /book|cancel|create|delete|send/.test(flag)
          ? `${flag} is refused: this tool is read-only and never books, cancels or changes anything`
          : `${flag} is refused: credentials are read from environment variables only (see docs/couriers.md), never from the command line`,
      );
    }
    const value = (): string => {
      const v = inline ?? args[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--provider': {
        const v = value();
        if (v !== 'pathao' && v !== 'steadfast')
          throw new Error('--provider must be pathao or steadfast');
        out.provider = v;
        break;
      }
      case '--environment': {
        const v = value();
        if (v !== 'sandbox' && v !== 'production')
          throw new Error('--environment must be sandbox or production');
        out.environment = v;
        break;
      }
      case '--host': {
        const v = value();
        if (v !== 'steadfast' && v !== 'packzy')
          throw new Error('--host must be steadfast or packzy');
        out.host = v;
        break;
      }
      case '--consignment': {
        const v = value();
        if (!REFERENCE_RE.test(v))
          throw new Error('--consignment has characters a courier id never has');
        out.consignment = v;
        break;
      }
      case '--reference': {
        const v = value();
        if (!REFERENCE_RE.test(v))
          throw new Error('--reference may only hold letters, digits, - and _');
        out.reference = v;
        break;
      }
      case '--city-id':
        out.cityId = positiveInt(flag, value());
        break;
      case '--zone-id':
        out.zoneId = positiveInt(flag, value());
        break;
      case '--store-id':
        out.storeId = positiveInt(flag, value());
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (!out.provider) throw new Error('--provider pathao|steadfast is required');
  return out as VerifyArgs;
}

export function readCredentials(
  provider: Provider,
  env: Record<string, string | undefined>,
): { credentials: Record<string, string>; missing: string[] } {
  const map: Record<string, string> = CREDENTIAL_ENV[provider];
  const optional = new Set([CREDENTIAL_ENV.pathao.username, CREDENTIAL_ENV.pathao.password]);
  const credentials: Record<string, string> = {};
  const missing: string[] = [];
  for (const [field, name] of Object.entries(map)) {
    const v = env[name];
    if (v) credentials[field] = v;
    else if (!optional.has(name as never)) missing.push(name);
  }
  const hasUser = Boolean(credentials['username']);
  const hasPass = Boolean(credentials['password']);
  if (provider === 'pathao' && hasUser !== hasPass)
    missing.push(hasUser ? CREDENTIAL_ENV.pathao.password : CREDENTIAL_ENV.pathao.username);
  return { credentials, missing };
}

/**
 * The only operations the verifier can reach. It is built from the adapter's read-only methods; `book` and `cancel` do not
 * exist on it, so a bug here cannot create or cancel a parcel.
 */
export interface ReadOnlyCourier {
  provider: Provider;
  verifyConnection: CourierAdapter['verifyConnection'];
  stores?: (() => Promise<{ id: number; name: string; active: boolean }[]>) | undefined;
  locations?: CourierAdapter['locations'];
  quote?: CourierAdapter['quote'];
  track: CourierAdapter['track'];
  findByReference?: CourierAdapter['findByReference'];
}

export function readOnly(
  adapter: CourierAdapter & { stores?: ReadOnlyCourier['stores'] },
): ReadOnlyCourier {
  return {
    provider: adapter.provider as Provider,
    verifyConnection: adapter.verifyConnection.bind(adapter),
    ...(adapter.stores ? { stores: adapter.stores.bind(adapter) } : {}),
    ...(adapter.locations ? { locations: adapter.locations } : {}),
    ...(adapter.quote ? { quote: adapter.quote.bind(adapter) } : {}),
    track: adapter.track.bind(adapter),
    ...(adapter.findByReference ? { findByReference: adapter.findByReference.bind(adapter) } : {}),
  };
}

export interface CheckRow {
  check: string;
  status: Status;
  detail: string;
}

/**
 * Text that is safe to print: the exact credential values are replaced first, then anything token-shaped, emails and phone
 * numbers. Provider replies can echo what we sent, so every printed detail goes through this.
 */
export function redactOutput(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 3) out = out.split(s).join('[REDACTED]');
  return out
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b[A-Za-z0-9+/=_-]{24,}\b/g, '[REDACTED]')
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]')
    .replace(/(?:\+?88)?01\d{9}\b/g, '[phone]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

const describeError = (e: unknown): string =>
  e instanceof CourierError
    ? `${e.kind}${e.status ? ` (HTTP ${e.status})` : ''}: ${e.message}`
    : e instanceof Error
      ? e.message
      : String(e);

/** Runs every read-only check the provider supports and returns the matrix. Never throws: a failing check is a FAIL row. */
export async function runVerification(
  courier: ReadOnlyCourier,
  args: VerifyArgs,
  secrets: string[],
): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];
  const add = (check: string, status: Status, detail: string) =>
    rows.push({ check, status, detail: redactOutput(detail, secrets) });
  const attempt = async <T>(
    check: string,
    fn: () => Promise<T>,
    ok: (v: T) => string,
  ): Promise<T | undefined> => {
    try {
      const v = await fn();
      add(check, 'PASS', ok(v));
      return v;
    } catch (e) {
      add(check, 'FAIL', describeError(e));
      return undefined;
    }
  };

  const connection = await attempt(
    'auth / token',
    () => courier.verifyConnection(),
    (c) =>
      courier.provider === 'pathao'
        ? `credentials accepted; ${c.details.length} detail line(s) (store names not printed)`
        : 'API key and secret key accepted',
  );

  if (courier.provider === 'pathao') {
    if (!connection) {
      for (const c of ['store list', 'city lookup', 'zone lookup', 'area lookup', 'price quote'])
        add(c, 'SKIP', 'authentication failed');
    } else {
      const stores = courier.stores
        ? await attempt(
            'store list',
            () => courier.stores!(),
            (s) => `${s.length} store(s): ids ${s.map((x) => x.id).join(', ') || 'none'}`,
          )
        : undefined;
      const cities = courier.locations
        ? await attempt(
            'city lookup',
            () => courier.locations!.cities(),
            (c) =>
              `${c.length} cities, e.g. ${c
                .slice(0, 3)
                .map((x) => x.name)
                .join(', ')}`,
          )
        : undefined;
      const cityId = args.cityId ?? cities?.[0]?.id;
      const zones =
        courier.locations && cityId
          ? await attempt(
              'zone lookup',
              () => courier.locations!.zones(cityId),
              (z) => `${z.length} zones in city ${cityId}`,
            )
          : (add('zone lookup', 'SKIP', 'no city id available'), undefined);
      const zoneId = args.zoneId ?? zones?.[0]?.id;
      if (courier.locations && zoneId)
        await attempt(
          'area lookup',
          () => courier.locations!.areas(zoneId),
          (a) => `${a.length} areas in zone ${zoneId}`,
        );
      else add('area lookup', 'SKIP', 'no zone id available');
      const storeId = args.storeId ?? stores?.find((s) => s.active)?.id;
      if (courier.quote && cityId && zoneId && storeId)
        await attempt(
          'price quote',
          () =>
            courier.quote!({
              recipient: { address: 'verification only' },
              codAmountMinor: 100_000,
              weightKg: 0.5,
              options: { cityId, zoneId, storeId },
            }),
          (q) =>
            `serviceable=${String(q.serviceable)}${q.feeMinor !== undefined ? `, fee ${(q.feeMinor / 100).toFixed(2)} BDT` : ''} (nothing booked)`,
        );
      else
        add(
          'price quote',
          'SKIP',
          'needs a store, city and zone (see --store-id/--city-id/--zone-id)',
        );
    }
    if (args.consignment)
      await attempt(
        'tracking lookup',
        () =>
          courier.track({
            consignmentId: args.consignment!,
            reference: args.reference ?? args.consignment!,
          }),
        (t) => `provider status "${t.providerStatus}" mapped to ${t.status}`,
      );
    else add('tracking lookup', 'SKIP', 'pass --consignment <id> of an existing parcel');
    add('lookup by our reference', 'N/A', 'Pathao documents no such lookup');
  } else {
    add('store list', 'N/A', 'not offered by Steadfast');
    add('city / zone / area lookup', 'N/A', 'not offered by Steadfast');
    add('price quote', 'N/A', 'Steadfast documents no estimate endpoint');
    if (!connection) {
      add('tracking lookup', 'SKIP', 'authentication failed');
      add('lookup by our reference', 'SKIP', 'authentication failed');
    } else {
      if (args.consignment)
        await attempt(
          'tracking lookup',
          () =>
            courier.track({
              consignmentId: args.consignment!,
              reference: args.reference ?? args.consignment!,
            }),
          (t) => `provider status "${t.providerStatus}" mapped to ${t.status}`,
        );
      else add('tracking lookup', 'SKIP', 'pass --consignment <id> of an existing parcel');
      if (args.reference && courier.findByReference)
        await attempt(
          'lookup by our reference',
          async () => courier.findByReference!(args.reference!),
          (t) =>
            t
              ? `found: provider status "${t.providerStatus}" mapped to ${t.status}`
              : 'the provider has no booking with that reference',
        );
      else
        add('lookup by our reference', 'SKIP', 'pass --reference <invoice> of an existing parcel');
    }
  }
  return rows;
}

export function formatMatrix(rows: CheckRow[], args: VerifyArgs): string[] {
  const width = Math.max(...rows.map((r) => r.check.length), 5);
  const header = `courier:verify  provider=${args.provider}  ${
    args.provider === 'pathao' ? `environment=${args.environment}` : `host=${args.host}`
  }  (read-only: books and cancels nothing)`;
  const lines = [header, ''];
  for (const r of rows)
    lines.push(`  ${r.check.padEnd(width)}  ${r.status.padEnd(4)}  ${r.detail}`);
  const fails = rows.filter((r) => r.status === 'FAIL').length;
  const passes = rows.filter((r) => r.status === 'PASS').length;
  const skipped = rows.filter((r) => r.status === 'SKIP').length;
  lines.push(
    '',
    `  ${passes} passed, ${fails} failed, ${skipped} skipped. ${
      fails
        ? 'NOT verified.'
        : skipped
          ? 'Partly verified: supply the arguments for the skipped checks.'
          : 'All supported read-only checks passed.'
    }`,
  );
  return lines;
}
