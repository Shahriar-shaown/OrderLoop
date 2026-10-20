import type { Tx } from '@orderloop/db';

/** A shipment in one of these states leaves nothing at the courier (it never existed or was cancelled); any other may. */
const NOT_LIVE = ['booking_failed', 'cancelled'] as const;

/** The order's shipment that exists, or may exist, at a courier (booking, unconfirmed, booked, on its way, ...). */
export async function liveShipmentOf(
  tx: Tx,
  tenantId: string,
  orderId: string,
): Promise<{ provider: string; status: string } | null> {
  return tx.shipment.findFirst({
    where: { tenantId, orderId, status: { notIn: [...NOT_LIVE] } },
    select: { provider: true, status: true },
  });
}
