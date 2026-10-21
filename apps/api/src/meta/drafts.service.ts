import { Injectable } from '@nestjs/common';
import {
  normalizeBdPhone,
  type ConfirmDraftBody,
  type ConfirmDraftResult,
  type DismissDraftBody,
  type ExtractedDraft,
  type PotentialDuplicate,
  type SocialDraft,
  type SocialDraftPage,
  type SocialDraftQuery,
  type SocialDraftSummary,
  type UpdateDraftBody,
} from '@orderloop/contracts';
import { Database, Prisma, type Tx } from '@orderloop/db';
import { divisionOfDistrict } from '@orderloop/domain';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import { decodeCursor, encodeCursor } from '../common/cursor.js';
import type { AuthContext } from '../common/endpoint.js';
import { OrdersService } from '../orders/orders.service.js';
import {
  effectiveDraft,
  TEXT_FIELDS,
  WARNING_TEXT,
  type DraftOverrides,
  type EffectiveDraft,
} from './draft-view.js';
import { MetaRuntime } from './meta.runtime.js';

type DraftRow = NonNullable<Awaited<ReturnType<Tx['socialDraft']['findFirst']>>> & {
  connection: { id: string; displayName: string; provider: 'facebook_page' | 'instagram' };
};
const withConnection = {
  connection: { select: { id: true, displayName: true, provider: true } },
} satisfies Prisma.SocialDraftInclude;

/** A repeat from the same customer's chat counts for this long (the same window the normal duplicate check uses). */
const SAME_SENDER_WINDOW_MS = 72 * 3_600_000;

const validation = (path: string, message: string) =>
  new ApiError('validation_failed', 'Request validation failed', [{ path, message }]);

const SNIPPET_LENGTH = 60;
/** How many of a draft's first messages are looked at for the first one that has text. */
const SNIPPET_LOOKAHEAD = 5;
type SnippetRow = { id: string; eventTimestamp: Date; payload: unknown };
const textOf = (e: SnippetRow) => (e.payload as { text?: unknown } | null)?.text;

/** The first 60 characters of the first message with text (code points, so an emoji is never cut in half). */
export function snippetOf(events: SnippetRow[]): string | null {
  const first = [...events]
    .sort(
      (a, b) => a.eventTimestamp.getTime() - b.eventTimestamp.getTime() || (a.id < b.id ? -1 : 1),
    )
    .map(textOf)
    .find((t): t is string => typeof t === 'string' && t.trim().length > 0);
  return first ? Array.from(first.trim()).slice(0, SNIPPET_LENGTH).join('') : null;
}

function summarise(
  row: DraftRow,
  eff: EffectiveDraft,
  snippet: string | null,
  orderNumber: number | null,
): SocialDraftSummary {
  return {
    id: row.id,
    status: row.status,
    mock: row.mock,
    provider: row.connection.provider,
    connectionId: row.connection.id,
    connectionName: row.connection.displayName,
    senderId: row.senderId,
    customerName: eff.customerName?.value ?? null,
    phone: eff.phone?.value ?? null,
    snippet,
    itemCount: eff.items.length,
    unmatchedItemCount: eff.items.filter((i) => i.variantId === null).length,
    messageCount: (row.sourceEventIds as string[]).length,
    firstMessageAt: row.firstMessageAt.toISOString(),
    lastMessageAt: row.lastMessageAt.toISOString(),
    orderId: row.orderId,
    orderNumber: row.orderId ? orderNumber : null,
  };
}
const effectiveOf = (row: DraftRow) =>
  effectiveDraft(row.extracted as Partial<ExtractedDraft>, row.overrides as DraftOverrides);

@Injectable()
export class DraftsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly orders: OrdersService,
    private readonly runtime: MetaRuntime,
  ) {}

  // ---- reading ----------------------------------------------------------------------------------------------------------

  async list(auth: AuthContext, query: SocialDraftQuery): Promise<SocialDraftPage> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    if (query.cursor && !cursor) throw validation('query.cursor', 'Invalid cursor');
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const rows = await tx.socialDraft.findMany({
        where: {
          tenantId: auth.tenantId,
          ...(query.status ? { status: query.status } : {}),
          ...(cursor
            ? {
                OR: [
                  { lastMessageAt: { lt: cursor.createdAt } },
                  { lastMessageAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        include: withConnection,
        orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      });
      const grouped = await tx.socialDraft.groupBy({
        by: ['status'],
        where: { tenantId: auth.tenantId },
        _count: { _all: true },
      });
      const count = (s: string) => grouped.find((g) => g.status === s)?._count._all ?? 0;
      const page = rows.slice(0, query.limit) as DraftRow[];
      const last = page.at(-1);
      const wantedEvents = page.flatMap((r) =>
        (r.sourceEventIds as string[]).slice(0, SNIPPET_LOOKAHEAD),
      );
      const events = wantedEvents.length
        ? await tx.socialEvent.findMany({
            where: { tenantId: auth.tenantId, id: { in: wantedEvents } },
            select: { id: true, eventTimestamp: true, payload: true },
          })
        : [];
      const eventById = new Map(events.map((e) => [e.id, e]));
      const orderIds = page.map((r) => r.orderId).filter((o): o is string => !!o);
      const numbers = new Map(
        (orderIds.length
          ? await tx.order.findMany({
              where: { tenantId: auth.tenantId, id: { in: orderIds } },
              select: { id: true, orderNumber: true },
            })
          : []
        ).map((o) => [o.id, o.orderNumber]),
      );
      return {
        mode: this.runtime.mode,
        items: page.map((r) =>
          summarise(
            r,
            effectiveOf(r),
            snippetOf(
              (r.sourceEventIds as string[])
                .slice(0, SNIPPET_LOOKAHEAD)
                .map((id) => eventById.get(id))
                .filter((e) => e !== undefined),
            ),
            r.orderId ? (numbers.get(r.orderId) ?? null) : null,
          ),
        ),
        nextCursor:
          rows.length > query.limit && last ? encodeCursor(last.lastMessageAt, last.id) : null,
        counts: {
          needs_review: count('needs_review'),
          confirmed: count('confirmed'),
          dismissed: count('dismissed'),
        },
      };
    });
  }

  private async load(tx: Tx, tenantId: string, id: string): Promise<DraftRow> {
    const row = await tx.socialDraft.findFirst({
      where: { id, tenantId },
      include: withConnection,
    });
    // Another business's draft is invisible under row-level security: not found, same as a missing one.
    if (!row) throw ApiError.notFound('Draft not found');
    return row as DraftRow;
  }

  /** Orders that look like a repeat: the normal check on phone and items, plus orders already made from this customer's chat. */
  private async duplicatesOf(tx: Tx, tenantId: string, row: DraftRow, eff: EffectiveDraft) {
    const found: PotentialDuplicate[] = [];
    const phone = eff.phone ? normalizeBdPhone(eff.phone.value) : null;
    if (phone)
      found.push(
        ...(await this.orders.findDuplicates(tx, tenantId, {
          phone,
          variantIds: eff.items.map((i) => i.variantId).filter((v): v is string => !!v),
          ...(row.orderId ? { excludeOrderId: row.orderId } : {}),
        })),
      );
    const siblings = await tx.socialDraft.findMany({
      where: {
        tenantId,
        connectionId: row.connection.id,
        senderId: row.senderId,
        status: 'confirmed',
        id: { not: row.id },
        orderId: { not: null },
        reviewedAt: { gte: new Date(Date.now() - SAME_SENDER_WINDOW_MS) },
      },
      select: { orderId: true, reviewedAt: true },
    });
    if (siblings.length) {
      const orders = await tx.order.findMany({
        where: {
          tenantId,
          id: { in: siblings.map((s) => s.orderId!) },
          status: { not: 'cancelled' },
        },
      });
      for (const o of orders) {
        const hours = Math.max(0, Math.floor((Date.now() - o.createdAt.getTime()) / 3_600_000));
        const reason = `An order was already made from this customer's chat ${hours < 1 ? 'less than an hour' : `${hours} hour${hours === 1 ? '' : 's'}`} ago`;
        const have = found.find((f) => f.orderId === o.id);
        if (have) have.reasons.push(reason);
        else
          found.push({
            orderId: o.id,
            orderNumber: o.orderNumber,
            status: o.status as PotentialDuplicate['status'],
            createdAt: o.createdAt.toISOString(),
            totalMinor: o.totalMinor,
            reasons: [reason],
          });
      }
    }
    return found;
  }

  private async view(tx: Tx, tenantId: string, row: DraftRow): Promise<SocialDraft> {
    const eff = effectiveOf(row);
    const extracted = row.extracted as Partial<ExtractedDraft>;
    const ids = row.sourceEventIds as string[];
    const events = ids.length
      ? await tx.socialEvent.findMany({
          where: { tenantId, id: { in: ids } },
          select: { id: true, eventTimestamp: true, payload: true },
          orderBy: [{ eventTimestamp: 'asc' }, { id: 'asc' }],
        })
      : [];
    const variantIds = eff.items.map((i) => i.variantId).filter((v): v is string => !!v);
    const variants = variantIds.length
      ? await tx.productVariant.findMany({
          where: { tenantId, id: { in: variantIds } },
          select: {
            id: true,
            sku: true,
            name: true,
            priceMinor: true,
            product: { select: { name: true } },
            stockLevels: { select: { onHand: true, reserved: true } },
          },
        })
      : [];
    const byId = new Map(variants.map((v) => [v.id, v]));
    const duplicates =
      row.status === 'needs_review' || row.orderId
        ? await this.duplicatesOf(tx, tenantId, row, eff)
        : [];

    const warnings = [...(extracted.warnings ?? [])];
    if (duplicates.length) warnings.push('duplicate_order');
    const district = eff.district?.value ?? null;
    const orderNumber = row.orderId
      ? ((
          await tx.order.findFirst({
            where: { tenantId, id: row.orderId },
            select: { orderNumber: true },
          })
        )?.orderNumber ?? null)
      : null;
    return {
      ...summarise(row, eff, snippetOf(events), orderNumber),
      mode: this.runtime.mode,
      fields: {
        ...(eff.customerName ? { customerName: eff.customerName } : {}),
        ...(eff.phone ? { phone: eff.phone } : {}),
        ...(eff.address ? { address: eff.address } : {}),
        ...(eff.district ? { district: eff.district } : {}),
        ...(eff.area ? { area: eff.area } : {}),
        ...(eff.postalCode ? { postalCode: eff.postalCode } : {}),
        ...(eff.note ? { note: eff.note } : {}),
        ...(eff.codAmountMinor ? { codAmountMinor: eff.codAmountMinor } : {}),
        items: eff.items.map((i) => {
          const v = i.variantId ? byId.get(i.variantId) : undefined;
          return {
            ...i,
            match: v
              ? {
                  sku: v.sku,
                  productName: v.product.name,
                  variantName: v.name,
                  priceMinor: v.priceMinor,
                  available: v.stockLevels.length
                    ? Math.max(
                        0,
                        v.stockLevels.reduce((n, l) => n + l.onHand - l.reserved, 0),
                      )
                    : null,
                }
              : null,
          };
        }),
      },
      suggestedDivision: district ? divisionOfDistrict(district) : null,
      warnings: warnings.map((code) => ({ code, message: WARNING_TEXT[code] ?? code })),
      messages: events.map((e) => {
        const p = e.payload as { text?: string; attachments?: { type: string }[] } | null;
        return {
          id: e.id,
          text: p?.text ?? null,
          attachmentTypes: (p?.attachments ?? []).map((a) => a.type),
          at: e.eventTimestamp.toISOString(),
        };
      }),
      duplicates,
      dismissedReason: row.dismissedReason,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  get(auth: AuthContext, id: string): Promise<SocialDraft> {
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) =>
      this.view(tx, auth.tenantId, await this.load(tx, auth.tenantId, id)),
    );
  }

  // ---- changing -----------------------------------------------------------------------------------------------------------

  /** Lock the draft row for the rest of the transaction: edits, confirm and dismiss take turns. */
  private async lock(tx: Tx, tenantId: string, id: string): Promise<DraftRow> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM social_drafts WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
    if (!locked[0]) throw ApiError.notFound('Draft not found');
    return this.load(tx, tenantId, id);
  }

  update(auth: AuthContext, id: string, body: UpdateDraftBody): Promise<SocialDraft> {
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const row = await this.lock(tx, auth.tenantId, id);
      if (row.status !== 'needs_review')
        throw new ApiError(
          'draft_closed',
          `This draft was already ${row.status.replace('_', ' ')}.`,
        );
      const next: Record<string, unknown> = { ...(row.overrides as DraftOverrides) };
      for (const key of TEXT_FIELDS) {
        const v = body[key];
        if (v === undefined) continue;
        if (v === null) delete next[key];
        else if (key === 'phone') {
          const phone = normalizeBdPhone(v);
          if (!phone)
            throw validation('body.phone', 'Enter a Bangladeshi mobile number like 01712-345678');
          next[key] = phone;
        } else next[key] = v;
      }
      if (body.codAmountMinor !== undefined) {
        if (body.codAmountMinor === null) delete next['codAmountMinor'];
        else next['codAmountMinor'] = body.codAmountMinor;
      }
      if (body.items !== undefined) {
        const wanted = body.items.map((i) => i.variantId).filter((v): v is string => !!v);
        const ok = new Set(
          (
            await tx.productVariant.findMany({
              where: { tenantId: auth.tenantId, id: { in: wanted }, archivedAt: null },
              select: { id: true },
            })
          ).map((v) => v.id),
        );
        body.items.forEach((i, n) => {
          if (i.variantId && !ok.has(i.variantId))
            throw validation(`body.items.${n}.variantId`, 'Item not found');
        });
        next['items'] = body.items.map((i) => ({
          variantId: i.variantId ?? null,
          text: i.text,
          quantity: i.quantity,
        }));
      }
      await tx.socialDraft.update({
        where: { id, tenantId: auth.tenantId },
        data: { overrides: next as Prisma.InputJsonValue },
      });
      return this.view(tx, auth.tenantId, await this.load(tx, auth.tenantId, id));
    });
  }

  /**
   * Make the order through the SAME path as manual entry (`OrdersService.createWithin`: stock, validation, duplicate rules,
   * audit), and link the draft in the same transaction: either both happen or neither. The draft row is locked first, so two
   * confirms take turns and the second just finds the draft confirmed and returns the same order.
   */
  async confirm(
    auth: AuthContext,
    id: string,
    body: ConfirmDraftBody,
    ip: string | null,
  ): Promise<ConfirmDraftResult> {
    let createdOrderId: string | null = null;
    const result = await this.db.withContext(
      { tenantId: auth.tenantId, userId: auth.userId },
      async (tx) => {
        const row = await this.lock(tx, auth.tenantId, id);
        if (row.status === 'confirmed' && row.orderId)
          return {
            draft: await this.view(tx, auth.tenantId, row),
            order: await this.orders.loadDetail(tx, auth.tenantId, row.orderId),
          };
        if (row.status !== 'needs_review')
          throw new ApiError(
            'draft_closed',
            `This draft was already ${row.status.replace('_', ' ')}.`,
          );

        const source = row.mock
          ? 'other'
          : row.connection.provider === 'instagram'
            ? 'instagram'
            : 'facebook';
        const { order, created } = await this.orders.createWithin(
          tx,
          auth,
          {
            ...body,
            source: body.source ?? source,
            sourceReference:
              body.sourceReference ??
              `${row.mock ? 'mock ' : ''}${row.connection.provider === 'instagram' ? 'instagram' : 'facebook'} draft ${row.id.slice(0, 8)}`,
          },
          ip,
        );
        // The order exists under this key already and belongs to ANOTHER draft: not a replay of this one.
        const other = await tx.socialDraft.findFirst({
          where: { tenantId: auth.tenantId, orderId: order.id },
        });
        if (other)
          throw new ApiError(
            'idempotency_conflict',
            'This idempotency key was already used for another draft',
          );
        await tx.socialDraft.update({
          where: { id, tenantId: auth.tenantId },
          data: {
            status: 'confirmed',
            orderId: order.id,
            reviewedById: auth.userId,
            reviewedAt: new Date(),
          },
        });
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'draft.confirmed',
          targetType: 'social_draft',
          targetId: id,
          metadata: { orderId: order.id, provider: row.connection.provider, mock: row.mock },
          ip,
        });
        if (created) createdOrderId = order.id;
        return {
          draft: await this.view(tx, auth.tenantId, await this.load(tx, auth.tenantId, id)),
          order,
        };
      },
    );
    if (createdOrderId) this.orders.announce(auth.tenantId, createdOrderId);
    return result;
  }

  dismiss(
    auth: AuthContext,
    id: string,
    body: DismissDraftBody,
    ip: string | null,
  ): Promise<SocialDraft> {
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const row = await this.lock(tx, auth.tenantId, id);
      if (row.status === 'confirmed')
        throw new ApiError('draft_closed', 'This draft was already confirmed into an order.');
      if (row.status === 'dismissed') return this.view(tx, auth.tenantId, row);
      await tx.socialDraft.update({
        where: { id, tenantId: auth.tenantId },
        data: {
          status: 'dismissed',
          dismissedReason: body.reason ?? null,
          reviewedById: auth.userId,
          reviewedAt: new Date(),
        },
      });
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'draft.dismissed',
        targetType: 'social_draft',
        targetId: id,
        metadata: { provider: row.connection.provider },
        ip,
      });
      return this.view(tx, auth.tenantId, await this.load(tx, auth.tenantId, id));
    });
  }
}
