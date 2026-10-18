import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  CourierSettings,
  type CourierCheck,
  type CourierConnection,
  type CourierEntry,
  type CourierProvider,
  type LocationItem,
  type SaveCourierBody,
  type ShippingQuote,
} from '@orderloop/contracts';
import { CourierError, type CourierAdapter } from '@orderloop/courier-sdk';
import { Database, type Tx } from '@orderloop/db';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import type { AuthContext } from '../common/endpoint.js';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { CredentialVault } from './credential-vault.js';
import {
  buildAdapter,
  capabilitiesOf,
  PROVIDER_LIST,
  PROVIDERS,
  type HttpOverrides,
} from './providers.js';

/** Replaced in tests with a fake network, so no test ever reaches a real courier. */
export const COURIER_HTTP = Symbol('COURIER_HTTP');

type ConnectionRow = NonNullable<Awaited<ReturnType<Tx['courierConnection']['findFirst']>>>;

const validation = (path: string, message: string) =>
  new ApiError(400, 'validation_failed', 'Request validation failed', [{ path, message }]);

/** A courier's failure, in the API's words. Nothing from the courier's reply is trusted to be safe to forward beyond its message. */
export function courierProblem(error: CourierError): ApiError {
  switch (error.kind) {
    case 'auth':
    case 'forbidden':
      return new ApiError(
        502,
        'courier_rejected',
        'The courier did not accept the saved credentials. Check them in Settings → Couriers.',
      );
    case 'validation':
      return new ApiError(
        422,
        'courier_rejected',
        `The courier refused the request: ${error.message}`,
        error.fields?.map((f) => ({ path: f.field, message: f.message })),
      );
    case 'unsupported':
      return new ApiError(422, 'courier_unsupported', error.message);
    case 'rate_limited':
      return new ApiError(
        429,
        'rate_limited',
        'The courier is limiting requests. Wait a moment and try again.',
      );
    case 'not_found':
      return new ApiError(404, 'not_found', 'The courier has no record of this.');
    default:
      return new ApiError(
        502,
        'courier_unavailable',
        'The courier could not be reached or did not answer properly. Try again shortly.',
      );
  }
}

@Injectable()
export class CouriersService {
  /** Adapters are kept so a Pathao login token is reused between requests; keyed so a saved change builds a fresh one. */
  private readonly adapters = new Map<string, CourierAdapter>();

  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly vault: CredentialVault,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(COURIER_HTTP) private readonly http: HttpOverrides = {},
  ) {}

  get mockEnabled(): boolean {
    return (
      (this.config.COURIER_MOCK_ENABLED ??
        (this.config.NODE_ENV === 'production' ? 'false' : 'true')) === 'true'
    );
  }

  private availability(provider: CourierProvider): { available: boolean; reason: string | null } {
    if (provider === 'mock')
      return this.mockEnabled
        ? { available: true, reason: null }
        : { available: false, reason: 'The simulated courier is switched off on this server.' };
    return this.vault.enabled
      ? { available: true, reason: null }
      : {
          available: false,
          reason:
            'This server has no COURIER_CREDENTIALS_KEY, so it cannot keep courier credentials safely. Ask whoever runs it to set one.',
        };
  }

  // ---- connections ---------------------------------------------------------------------------------------------------

  private webhookUrl(row: ConnectionRow): string | null {
    if (!PROVIDERS[row.provider].webhookSecret) return null;
    const base = (this.config.API_PUBLIC_URL ?? `http://localhost:${this.config.API_PORT}`).replace(
      /\/+$/,
      '',
    );
    return `${base}/v1/webhooks/couriers/${row.provider}/${row.tenantId}/${row.id}`;
  }

  private toConnection(row: ConnectionRow): CourierConnection {
    const settings = CourierSettings.safeParse(row.settings);
    return {
      id: row.id,
      environment: row.environment,
      hasCredentials: row.provider === 'mock' ? false : !!row.credentialsEnc,
      hasWebhookSecret: !!row.webhookSecretEnc,
      settings: settings.success ? settings.data : {},
      enabled: row.enabled,
      webhookUrl: this.webhookUrl(row),
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      lastCheckOk: row.lastCheckOk,
      lastCheckMessage: row.lastCheckMessage,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toEntry(provider: CourierProvider, row: ConnectionRow | null | undefined): CourierEntry {
    const info = PROVIDERS[provider];
    const { available, reason } = this.availability(provider);
    return {
      provider,
      name: info.name,
      simulated: provider === 'mock',
      capabilities: capabilitiesOf(provider),
      environments: info.environments,
      credentialFields: info.fields,
      available,
      unavailableReason: reason,
      connection: row ? this.toConnection(row) : null,
    };
  }

  async list(auth: AuthContext): Promise<CourierEntry[]> {
    const rows = await this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
      tx.courierConnection.findMany({ where: { tenantId: auth.tenantId } }),
    );
    return PROVIDER_LIST.map((p) =>
      this.toEntry(
        p,
        rows.find((r) => r.provider === p),
      ),
    );
  }

  async save(
    auth: AuthContext,
    provider: CourierProvider,
    body: SaveCourierBody,
    ip: string | null,
  ): Promise<CourierEntry> {
    const info = PROVIDERS[provider];
    const { available, reason } = this.availability(provider);
    if (!available) throw new ApiError(409, 'courier_not_configured', reason ?? undefined);

    // Reject what this courier does not take, rather than quietly ignoring it.
    const allowedKeys = new Set(info.fields.map((f) => f.key));
    for (const key of Object.keys(body.credentials ?? {}))
      if (!allowedKeys.has(key))
        throw validation(`credentials.${key}`, `${info.name} does not use this`);
    for (const key of Object.keys(body.settings ?? {}))
      if (!info.settings.includes(key as keyof CourierSettings))
        throw validation(`settings.${key}`, `${info.name} does not use this`);
    if (body.webhookSecret !== undefined && !info.webhookSecret)
      throw validation('webhookSecret', `${info.name} sends no webhooks`);
    if (body.environment !== undefined && !info.environments.includes(body.environment))
      throw validation('environment', `${info.name} offers: ${info.environments.join(', ')}`);

    const scope = { tenantId: auth.tenantId, provider };
    const row = await this.db.withContext(
      { tenantId: auth.tenantId, userId: auth.userId },
      async (tx) => {
        const existing = await tx.courierConnection.findFirst({
          where: { tenantId: auth.tenantId, provider },
        });
        let credentialsEnc = existing?.credentialsEnc ?? null;
        let credentialsChanged = false;
        if (provider !== 'mock') {
          const merged: Record<string, string> = {
            ...(credentialsEnc
              ? this.vault.decryptJson<Record<string, string>>(credentialsEnc, scope)
              : {}),
            ...Object.fromEntries(
              Object.entries(body.credentials ?? {}).filter(([, v]) => v !== undefined),
            ),
          };
          for (const field of info.fields)
            if (!field.optional && !merged[field.key])
              throw validation(`credentials.${field.key}`, `${field.label} is required`);
          if (body.credentials && Object.keys(body.credentials).length) {
            credentialsEnc = this.vault.encryptJson(merged, scope);
            credentialsChanged = true;
          }
        }
        const webhookSecretEnc =
          body.webhookSecret !== undefined
            ? this.vault.encrypt(body.webhookSecret, scope)
            : (existing?.webhookSecretEnc ?? null);

        const environment =
          body.environment ??
          existing?.environment ??
          (info.environments[0] as CourierConnection['environment']);
        const previous = CourierSettings.safeParse(existing?.settings ?? {});
        const settings = { ...(previous.success ? previous.data : {}), ...(body.settings ?? {}) };
        // Changing what we talk to makes an earlier "it works" meaningless.
        const reconnect =
          credentialsChanged ||
          environment !== existing?.environment ||
          settings.host !== (previous.success ? previous.data.host : undefined);

        const data = {
          environment,
          credentialsEnc,
          webhookSecretEnc,
          settings,
          enabled: body.enabled ?? true,
          ...(reconnect ? { lastCheckedAt: null, lastCheckOk: null, lastCheckMessage: null } : {}),
        };
        const saved = existing
          ? await tx.courierConnection.update({ where: { id: existing.id }, data })
          : await tx.courierConnection.create({
              data: { tenantId: auth.tenantId, provider, ...data },
            });
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'courier.connection_saved',
          targetType: 'courier_connection',
          targetId: saved.id,
          // What changed, never the values.
          metadata: {
            provider,
            environment,
            credentialsChanged,
            webhookSecretChanged: body.webhookSecret !== undefined,
            enabled: saved.enabled,
          },
          ip,
        });
        return saved;
      },
    );
    return this.toEntry(provider, row);
  }

  async remove(
    auth: AuthContext,
    provider: CourierProvider,
    ip: string | null,
  ): Promise<CourierEntry> {
    const row = await this.db.withContext(
      { tenantId: auth.tenantId, userId: auth.userId },
      async (tx) => {
        const existing = await tx.courierConnection.findFirst({
          where: { tenantId: auth.tenantId, provider },
        });
        if (!existing) throw ApiError.notFound('This courier is not connected');
        const saved = await tx.courierConnection.update({
          where: { id: existing.id },
          data: {
            credentialsEnc: null,
            webhookSecretEnc: null,
            enabled: false,
            lastCheckedAt: null,
            lastCheckOk: null,
            lastCheckMessage: null,
          },
        });
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'courier.connection_removed',
          targetType: 'courier_connection',
          targetId: saved.id,
          metadata: { provider },
          ip,
        });
        return saved;
      },
    );
    this.forget(row.id);
    return this.toEntry(provider, row);
  }

  // ---- adapters ------------------------------------------------------------------------------------------------------

  private forget(connectionId: string): void {
    for (const key of this.adapters.keys())
      if (key.startsWith(`${connectionId}:`)) this.adapters.delete(key);
  }

  /** The connection for a courier, ready to use: present, switched on, and holding what it needs. */
  async usableConnection(
    tx: Tx,
    tenantId: string,
    provider: CourierProvider,
  ): Promise<ConnectionRow> {
    const row = await tx.courierConnection.findFirst({ where: { tenantId, provider } });
    if (!row || !row.enabled)
      throw new ApiError(
        409,
        'courier_not_configured',
        `${PROVIDERS[provider].name} is not connected. Connect it in Settings → Couriers.`,
      );
    if (provider === 'mock' && !this.mockEnabled)
      throw new ApiError(
        409,
        'courier_not_configured',
        'The simulated courier is switched off on this server.',
      );
    if (provider !== 'mock' && !row.credentialsEnc)
      throw new ApiError(
        409,
        'courier_not_configured',
        `${PROVIDERS[provider].name} has no saved credentials.`,
      );
    return row;
  }

  adapterFor(row: ConnectionRow): CourierAdapter {
    const key = `${row.id}:${row.updatedAt.getTime()}`;
    let adapter = this.adapters.get(key);
    if (!adapter) {
      this.forget(row.id);
      let credentials: Record<string, string> = {};
      if (row.provider !== 'mock') {
        if (!row.credentialsEnc)
          throw new ApiError(409, 'courier_not_configured', 'No saved credentials.');
        try {
          credentials = this.vault.decryptJson<Record<string, string>>(row.credentialsEnc, {
            tenantId: row.tenantId,
            provider: row.provider,
          });
        } catch {
          throw new ApiError(
            409,
            'courier_not_configured',
            'The saved credentials can no longer be read. Enter them again in Settings → Couriers.',
          );
        }
      }
      const parsed = CourierSettings.safeParse(row.settings);
      adapter = buildAdapter(row.provider, {
        scope: row.tenantId,
        credentials,
        settings: parsed.success ? parsed.data : {},
        environment: row.environment,
        http: this.http,
      });
      this.adapters.set(key, adapter);
      if (this.adapters.size > 500)
        this.adapters.delete(this.adapters.keys().next().value as string);
    }
    return adapter;
  }

  /** Decrypted webhook secret, or null when none is saved or it cannot be read. */
  webhookSecret(row: ConnectionRow): string | null {
    if (!row.webhookSecretEnc) return null;
    try {
      return this.vault.decrypt(row.webhookSecretEnc, {
        tenantId: row.tenantId,
        provider: row.provider,
      });
    } catch {
      return null;
    }
  }

  // ---- checks, locations, quotes ---------------------------------------------------------------------------------------

  async test(
    auth: AuthContext,
    provider: CourierProvider,
    ip: string | null,
  ): Promise<CourierCheck> {
    const row = await this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
      this.usableConnection(tx, auth.tenantId, provider),
    );
    let check: CourierCheck;
    try {
      const result = await this.adapterFor(row).verifyConnection();
      check = {
        ok: true,
        details: result.details,
        message: null,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      const message =
        error instanceof CourierError
          ? error.kind === 'auth' || error.kind === 'forbidden'
            ? 'The courier did not accept these credentials.'
            : error.kind === 'unavailable'
              ? 'The courier could not be reached. Try again shortly.'
              : error.message
          : 'The check failed unexpectedly.';
      check = { ok: false, details: [], message, checkedAt: new Date().toISOString() };
    }
    await this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      await tx.courierConnection.updateMany({
        where: { id: row.id, tenantId: auth.tenantId },
        data: {
          lastCheckedAt: new Date(check.checkedAt),
          lastCheckOk: check.ok,
          lastCheckMessage: check.message ?? check.details.join(' · '),
        },
      });
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'courier.connection_tested',
        targetType: 'courier_connection',
        targetId: row.id,
        metadata: { provider, ok: check.ok },
        ip,
      });
    });
    return check;
  }

  async locations(
    auth: AuthContext,
    provider: CourierProvider,
    query: { kind: 'cities' | 'zones' | 'areas'; parentId?: number | undefined },
  ): Promise<LocationItem[]> {
    const row = await this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
      this.usableConnection(tx, auth.tenantId, provider),
    );
    const adapter = this.adapterFor(row);
    if (!adapter.locations)
      throw new ApiError(
        422,
        'courier_unsupported',
        `${PROVIDERS[provider].name} has no place lists.`,
      );
    try {
      if (query.kind === 'cities') return await adapter.locations.cities();
      if (!query.parentId) throw validation('query.parentId', 'Choose the parent place first');
      return query.kind === 'zones'
        ? await adapter.locations.zones(query.parentId)
        : await adapter.locations.areas(query.parentId);
    } catch (error) {
      if (error instanceof CourierError) throw courierProblem(error);
      throw error;
    }
  }

  async quote(
    auth: AuthContext,
    orderId: string,
    body: {
      provider: CourierProvider;
      weightKg?: number | undefined;
      cityId?: number | undefined;
      zoneId?: number | undefined;
      areaId?: number | undefined;
    },
  ): Promise<ShippingQuote> {
    const { row, order } = await this.db.withContext({ tenantId: auth.tenantId }, async (tx) => ({
      row: await this.usableConnection(tx, auth.tenantId, body.provider),
      order: await tx.order.findFirst({ where: { id: orderId, tenantId: auth.tenantId } }),
    }));
    if (!order) throw ApiError.notFound('Order not found');
    const adapter = this.adapterFor(row);
    const simulated = adapter.simulated;
    if (!adapter.quote)
      return {
        provider: body.provider,
        simulated,
        serviceable: null,
        feeMinor: null,
        codEnabled: null,
        codFeeMinor: null,
        message: `${PROVIDERS[body.provider].name} gives no estimate before booking. The fee is reported when the parcel is booked.`,
      };
    try {
      const q = await adapter.quote({
        recipient: {
          address: [order.shipLine1, order.shipArea, order.shipDistrict, order.shipDivision].join(
            ', ',
          ),
        },
        codAmountMinor: order.codAmountMinor,
        weightKg: body.weightKg,
        options: { cityId: body.cityId, zoneId: body.zoneId, areaId: body.areaId },
      });
      return {
        provider: body.provider,
        simulated,
        serviceable: q.serviceable,
        feeMinor: q.feeMinor ?? null,
        codEnabled: q.codEnabled ?? null,
        codFeeMinor: q.codFeeMinor ?? null,
        message: q.notes.length ? q.notes.join(' ') : null,
      };
    } catch (error) {
      if (error instanceof CourierError) throw courierProblem(error);
      throw error;
    }
  }
}
