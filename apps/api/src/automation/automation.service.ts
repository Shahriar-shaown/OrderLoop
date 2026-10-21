import { Injectable } from '@nestjs/common';
import {
  mergeChannels,
  retryDelivery,
  retryRun,
  runRuleNow,
  toRuleRecord,
  toRunRecord,
} from '@orderloop/automation';
import {
  AUTOMATION_KINDS,
  DEFAULT_RULE_CHANNELS,
  DEFAULT_RULE_CONFIG,
  parseRuleConfig,
  type AutomationKind,
  type AutomationRule,
  type AutomationRules,
  type DeliveryPage,
  type DeliveryQuery,
  type Run,
  type RunPage,
  type RunQuery,
  type RunRuleBody,
  type RuleChannels,
  type UpdateRuleBody,
} from '@orderloop/contracts';
import { Database, Prisma } from '@orderloop/db';
import { roleCanReceive } from '@orderloop/domain';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import { decodeCursor, encodeCursor } from '../common/cursor.js';
import type { AuthContext } from '../common/endpoint.js';
import { AutomationRuntime } from './automation.runtime.js';
import { toDelivery, toRule, toRun } from './automation.mapper.js';

/** Manual evaluations one business may start per minute: enough for a person clicking, far below anything abusive. */
export const MANUAL_RUNS_PER_MINUTE = 10;

const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(sort(a)) === JSON.stringify(sort(b));
function sort(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sort);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, sort(x)]),
    );
  return v;
}

@Injectable()
export class AutomationService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly runtime: AutomationRuntime,
  ) {}

  // ---- rules ---------------------------------------------------------------------------------------------------------

  async listRules(auth: AuthContext): Promise<AutomationRules> {
    const rules = await this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const rows = await tx.automationRule.findMany({ where: { tenantId: auth.tenantId } });
      const byKind = new Map(rows.map((r) => [r.kind, r]));
      const out: AutomationRule[] = [];
      for (const kind of AUTOMATION_KINDS) {
        const row = byKind.get(kind);
        const last = row
          ? await tx.automationRun.findFirst({
              where: { tenantId: auth.tenantId, ruleId: row.id },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            })
          : null;
        out.push(toRule(kind, row, last ? toRunRecord(last) : null));
      }
      return out;
    });
    return {
      rules,
      providers: {
        push: this.runtime.config.PUSH_PROVIDER,
        sms: this.runtime.channels.sms,
        whatsapp: this.runtime.channels.whatsapp,
        email: true,
      },
    };
  }

  async updateRule(
    auth: AuthContext,
    kind: AutomationKind,
    body: UpdateRuleBody,
    ip: string | null,
  ): Promise<AutomationRule> {
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const existing = await tx.automationRule.findUnique({
        where: { tenantId_kind: { tenantId: auth.tenantId, kind } },
      });
      const before = existing
        ? toRuleRecord(existing)
        : {
            enabled: false,
            config: { ...DEFAULT_RULE_CONFIG[kind] } as Record<string, unknown>,
            channels: { ...DEFAULT_RULE_CHANNELS },
          };

      let config = before.config;
      if (body.config !== undefined) {
        const parsed = parseRuleConfig(kind, body.config);
        if (!parsed.ok)
          throw new ApiError(
            'validation_failed',
            'Request validation failed',
            parsed.issues.map((i) => ({
              path: ['body', 'config', i.path].filter(Boolean).join('.'),
              message: i.message,
            })),
          );
        config = parsed.config;
      }
      const channels: RuleChannels = {
        ...before.channels,
        ...(body.channels ?? {}),
      } as RuleChannels;
      const enabled = body.enabled ?? before.enabled;

      // sms and whatsapp: a provider must exist, and somebody who will receive it must have consented
      for (const channel of ['sms', 'whatsapp'] as const) {
        if (
          !channels[channel] ||
          !(body.channels?.[channel] || (body.enabled && enabled && !before.enabled))
        )
          continue;
        if (!this.runtime.channels[channel])
          throw new ApiError(
            'channel_not_configured',
            `${channel === 'sms' ? 'SMS' : 'WhatsApp'} is not set up on this server`,
          );
        const consents = await tx.messagingConsent.findMany({
          where: { tenantId: auth.tenantId, channel, revokedAt: null },
          select: { userId: true },
        });
        const members = await tx.membership.findMany({
          where: { tenantId: auth.tenantId, userId: { in: consents.map((c) => c.userId) } },
          select: { role: true },
        });
        if (!members.some((m) => roleCanReceive(m.role, kind)))
          throw new ApiError(
            'consent_required',
            `Nobody who would receive this has agreed to ${channel === 'sms' ? 'SMS' : 'WhatsApp'} messages yet`,
          );
      }

      const changed: string[] = [];
      if (enabled !== before.enabled) changed.push('enabled');
      if (!sameJson(config, before.config)) changed.push('config');
      if (!sameJson(channels, mergeChannels(before.channels))) changed.push('channels');

      const now = this.runtime.now();
      const justEnabled = enabled && !before.enabled;
      const row = await tx.automationRule.upsert({
        where: { tenantId_kind: { tenantId: auth.tenantId, kind } },
        create: {
          tenantId: auth.tenantId,
          kind,
          enabled,
          config: config as Prisma.InputJsonObject,
          channels: channels as unknown as Prisma.InputJsonObject,
          enabledAt: enabled ? now : null,
          updatedById: auth.userId,
        },
        update: changed.length
          ? {
              enabled,
              config: config as Prisma.InputJsonObject,
              channels: channels as unknown as Prisma.InputJsonObject,
              ...(justEnabled ? { enabledAt: now } : {}),
              updatedById: auth.userId,
            }
          : {},
      });
      // a rule saved for the first time with nothing different from the defaults is still a change worth recording
      if (!existing && !changed.length) changed.push('created');
      if (changed.length)
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'automation.rule_changed',
          targetType: 'automation_rule',
          targetId: row.id,
          metadata: { kind, fields: changed },
          ip,
        });
      const last = await tx.automationRun.findFirst({
        where: { tenantId: auth.tenantId, ruleId: row.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      return toRule(kind, row, last ? toRunRecord(last) : null);
    });
  }

  // ---- runs ----------------------------------------------------------------------------------------------------------

  /** Evaluate a rule now, for the caller's business. See `runRuleNow` for how it shares slots and de-duplication with the scheduler. */
  async runRule(auth: AuthContext, kind: AutomationKind, body: RunRuleBody): Promise<Run> {
    const ctx = { tenantId: auth.tenantId };
    const prep = await this.db.withContext(ctx, async (tx) => {
      const rule = await tx.automationRule.findUnique({
        where: { tenantId_kind: { tenantId: auth.tenantId, kind } },
        select: { id: true, enabled: true },
      });
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: auth.tenantId },
        select: { timezone: true },
      });
      const recent = await tx.automationRun.count({
        where: {
          tenantId: auth.tenantId,
          trigger: 'manual',
          createdAt: { gte: new Date(this.runtime.now().getTime() - 60_000) },
        },
      });
      return { rule, timezone: tenant.timezone, recent };
    });
    if (!prep.rule || !prep.rule.enabled)
      throw ApiError.conflict('Save and switch on this rule before running it');
    if (prep.recent >= MANUAL_RUNS_PER_MINUTE)
      throw new ApiError('rate_limited', 'Too many manual runs; wait a minute and try again');
    const result = await runRuleNow(this.runtime.deps, {
      tenantId: auth.tenantId,
      ruleId: prep.rule.id,
      kind,
      timezone: prep.timezone,
      idempotencyKey: body.idempotencyKey,
    });
    if (!result.run) throw ApiError.conflict('Save and switch on this rule before running it');
    return toRun(result.run);
  }

  async listRuns(auth: AuthContext, query: RunQuery): Promise<RunPage> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
      tx.automationRun.findMany({
        where: {
          tenantId: auth.tenantId,
          ...(query.status ? { status: query.status } : {}),
          ...(query.kind ? { kind: query.kind } : {}),
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      }),
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => toRun(toRunRecord(r))),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  async retryRun(auth: AuthContext, id: string): Promise<Run> {
    const run = await retryRun(this.runtime.deps, auth.tenantId, id);
    if (!run) throw ApiError.notFound('Run not found');
    return toRun(run);
  }

  // ---- deliveries ----------------------------------------------------------------------------------------------------

  async listDeliveries(auth: AuthContext, query: DeliveryQuery): Promise<DeliveryPage> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
      tx.notificationDelivery.findMany({
        where: {
          tenantId: auth.tenantId,
          ...(query.status ? { status: query.status } : {}),
          ...(query.channel ? { channel: query.channel } : {}),
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        include: { notification: { select: { kind: true, userId: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      }),
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(toDelivery),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  async retryDelivery(auth: AuthContext, id: string) {
    const moved = await retryDelivery(this.runtime.deps, auth.tenantId, id);
    if (!moved) throw ApiError.notFound('Delivery not found');
    const row = await this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
      tx.notificationDelivery.findFirstOrThrow({
        where: { id, tenantId: auth.tenantId },
        include: { notification: { select: { kind: true, userId: true } } },
      }),
    );
    return toDelivery(row);
  }
}
