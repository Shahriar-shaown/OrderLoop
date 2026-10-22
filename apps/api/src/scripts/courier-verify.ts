// First-contact check of a courier integration with REAL credentials you supply: read-only, books and cancels nothing.
// Credentials come from environment variables ONLY (names in docs/couriers.md); nothing is stored, and no .env file is read.
// Run: pnpm courier:verify -- --provider pathao --environment sandbox [--consignment <id>] [--city-id n --zone-id n --store-id n]
//      pnpm courier:verify -- --provider steadfast [--reference <invoice>] [--consignment <id>]
import { PathaoAdapter, SteadfastAdapter } from '@orderloop/courier-sdk';
import {
  CREDENTIAL_ENV,
  formatMatrix,
  parseVerifyArgs,
  readCredentials,
  readOnly,
  runVerification,
  type VerifyArgs,
} from './courier-verify-lib.js';

let args: VerifyArgs;
try {
  args = parseVerifyArgs(process.argv.slice(2));
} catch (e) {
  console.error((e as Error).message);
  console.error(
    'Usage: pnpm courier:verify -- --provider pathao|steadfast [--environment sandbox|production] [--host steadfast|packzy] [--consignment <id>] [--reference <ref>] [--city-id n] [--zone-id n] [--store-id n]',
  );
  process.exit(2);
}

const { credentials, missing } = readCredentials(args.provider, process.env);
if (missing.length > 0) {
  console.error(`Missing environment variable(s): ${missing.join(', ')}`);
  console.error('Export them for this one command only, for example:');
  for (const name of Object.values(CREDENTIAL_ENV[args.provider]))
    console.error(`  ${name}=... \\`);
  console.error('  pnpm courier:verify -- --provider ' + args.provider);
  process.exit(2);
}
if (args.provider === 'pathao' && args.environment === 'production')
  console.error('Note: --environment production uses your REAL Pathao account (still read-only).');

const adapter =
  args.provider === 'pathao'
    ? new PathaoAdapter({
        credentials: {
          clientId: credentials['clientId']!,
          clientSecret: credentials['clientSecret']!,
          username: credentials['username'],
          password: credentials['password'],
        },
        settings: { environment: args.environment, storeId: args.storeId },
      })
    : new SteadfastAdapter({
        credentials: { apiKey: credentials['apiKey']!, secretKey: credentials['secretKey']! },
        settings: { host: args.host },
      });

const rows = await runVerification(readOnly(adapter), args, Object.values(credentials));
for (const line of formatMatrix(rows, args)) console.log(line);
console.log(
  JSON.stringify({
    time: new Date().toISOString(),
    event: 'courier.verify',
    provider: args.provider,
    results: Object.fromEntries(rows.map((r) => [r.check, r.status])),
  }),
);
process.exit(rows.some((r) => r.status === 'FAIL') ? 1 : 0);
