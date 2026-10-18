import {
  MockAdapter,
  PathaoAdapter,
  SteadfastAdapter,
  type Capabilities,
  type CourierAdapter,
  type FetchLike,
} from '@orderloop/courier-sdk';
import type { CourierEnvironment, CourierProvider, CourierSettings } from '@orderloop/contracts';

export interface CredentialField {
  key: string;
  label: string;
  optional: boolean;
}

export interface ProviderInfo {
  name: string;
  fields: CredentialField[];
  /** Environments a seller may pick. */
  environments: CourierEnvironment[];
  /** Settings keys this courier understands. */
  settings: (keyof CourierSettings)[];
  /** Whether the courier is told about status changes by webhook, and so has a webhook secret. */
  webhookSecret: boolean;
}

export const PROVIDERS: Record<CourierProvider, ProviderInfo> = {
  mock: {
    name: 'Simulated courier',
    fields: [],
    environments: ['simulated'],
    settings: ['outcome', 'referenceLookup'],
    webhookSecret: false,
  },
  pathao: {
    name: 'Pathao Courier',
    fields: [
      { key: 'clientId', label: 'Client ID', optional: false },
      { key: 'clientSecret', label: 'Client secret', optional: false },
      { key: 'username', label: 'Merchant email (only if Pathao gave you one)', optional: true },
      { key: 'password', label: 'Merchant password (only if Pathao gave you one)', optional: true },
    ],
    environments: ['sandbox', 'production'],
    settings: ['storeId', 'deliveryType', 'itemType', 'defaultWeightKg'],
    webhookSecret: true,
  },
  steadfast: {
    name: 'Steadfast Courier',
    fields: [
      { key: 'apiKey', label: 'API key', optional: false },
      { key: 'secretKey', label: 'Secret key', optional: false },
    ],
    // Steadfast documents no sandbox: only the live service.
    environments: ['production'],
    settings: ['host'],
    webhookSecret: true,
  },
};

export const PROVIDER_LIST = Object.keys(PROVIDERS) as CourierProvider[];

const capabilityCache = new Map<CourierProvider, Capabilities>();
/** What a courier can do, read from its adapter (a throwaway one, no network). */
export function capabilitiesOf(provider: CourierProvider): Capabilities {
  let caps = capabilityCache.get(provider);
  if (!caps) {
    caps = buildAdapter(provider, {
      scope: 'capabilities',
      credentials: { clientId: 'x', clientSecret: 'x', apiKey: 'x', secretKey: 'x' },
      settings: {},
      environment: provider === 'pathao' ? 'sandbox' : 'production',
    }).capabilities;
    capabilityCache.set(provider, caps);
  }
  return caps;
}

export interface HttpOverrides {
  fetch?: FetchLike | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export function buildAdapter(
  provider: CourierProvider,
  input: {
    scope: string;
    credentials: Record<string, string>;
    settings: CourierSettings;
    environment: CourierEnvironment;
    http?: HttpOverrides;
  },
): CourierAdapter {
  const { credentials: c, settings: s, http } = input;
  switch (provider) {
    case 'mock':
      return new MockAdapter(input.scope, {
        outcome: s.outcome,
        referenceLookup: s.referenceLookup,
      });
    case 'pathao':
      return new PathaoAdapter({
        credentials: {
          clientId: c['clientId'] ?? '',
          clientSecret: c['clientSecret'] ?? '',
          ...(c['username'] && c['password']
            ? { username: c['username'], password: c['password'] }
            : {}),
        },
        settings: {
          environment: input.environment === 'production' ? 'production' : 'sandbox',
          ...(s.storeId !== undefined ? { storeId: s.storeId } : {}),
          ...(s.deliveryType !== undefined ? { deliveryType: s.deliveryType } : {}),
          ...(s.itemType !== undefined ? { itemType: s.itemType } : {}),
          ...(s.defaultWeightKg !== undefined ? { defaultWeightKg: s.defaultWeightKg } : {}),
        },
        fetch: http?.fetch,
        sleep: http?.sleep,
      });
    case 'steadfast':
      return new SteadfastAdapter({
        credentials: { apiKey: c['apiKey'] ?? '', secretKey: c['secretKey'] ?? '' },
        settings: { host: s.host ?? 'steadfast' },
        fetch: http?.fetch,
        sleep: http?.sleep,
      });
  }
}
