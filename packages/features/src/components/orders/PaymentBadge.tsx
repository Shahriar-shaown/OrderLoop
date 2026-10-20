import type { PaymentState } from '@orderloop/contracts';
import { Badge, type Tone } from '@orderloop/ui';

export const PAYMENT_LABEL: Record<PaymentState, string> = {
  prepaid: 'Prepaid',
  cod_pending: 'COD · Pending',
  cod_unpaid: 'COD · Not received',
  cod_partial: 'COD · Partly received',
  cod_collected: 'COD · Collected',
  cod_untracked: 'COD · Not tracked',
  not_due: 'Nothing due',
};

export const PAYMENT_TONE: Record<PaymentState, Tone> = {
  prepaid: 'success',
  cod_pending: 'warning',
  cod_unpaid: 'error',
  cod_partial: 'warning',
  cod_collected: 'success',
  cod_untracked: 'neutral',
  not_due: 'neutral',
};

/**
 * Where an order's cash stands. "Collected" only ever means a courier statement reported the cash: a delivered order is
 * "Not received" until one does.
 */
export function PaymentBadge({ state }: { state: PaymentState }) {
  return (
    <Badge tone={PAYMENT_TONE[state]} dot>
      {PAYMENT_LABEL[state]}
    </Badge>
  );
}
