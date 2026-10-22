import { z } from 'zod';
import { Uuid } from './auth.js';

// Erasing a customer's personal data, deleting an account, deleting a business. Technical capabilities described in
// docs/privacy-and-deletion.md; none of this is a statement about any law.

/** A person asks for a customer's personal data to be removed. Irreversible, so it must be confirmed in the body. */
export const EraseCustomerBody = z.object({
  confirm: z.literal(true, { error: 'Confirm that this cannot be undone' }),
  /** Why (for the record). Kept in the audit trail with the customer's own name and number taken out: do not put other personal details in it. */
  reason: z.string().trim().min(1).max(200).optional(),
});
export type EraseCustomerBody = z.infer<typeof EraseCustomerBody>;

export const EraseCustomerResult = z.object({
  customerId: Uuid,
  erasedAt: z.string(),
  /** Orders whose copies of the name, phone and address were erased (their totals, statuses and dates stay). */
  ordersAnonymised: z.number().int().min(0),
});
export type EraseCustomerResult = z.infer<typeof EraseCustomerResult>;

/** The person deletes their own account. The password is asked again even though they are signed in. */
export const DeleteAccountBody = z.object({
  password: z.string().min(1, 'Password is required').max(128),
  confirm: z.literal('DELETE', { error: 'Type DELETE to confirm' }),
});
export type DeleteAccountBody = z.infer<typeof DeleteAccountBody>;

export const ScheduledBusiness = z.object({
  id: Uuid,
  name: z.string(),
  /** When the business and its data will be deleted for good. */
  purgeAfter: z.string(),
});
export type ScheduledBusiness = z.infer<typeof ScheduledBusiness>;

export const DeleteAccountResult = z.object({
  deleted: z.literal(true),
  /** Businesses the person was the only member of: they are now scheduled for deletion (see `purgeAfter`). */
  businessesScheduled: z.array(ScheduledBusiness),
});
export type DeleteAccountResult = z.infer<typeof DeleteAccountResult>;

/** The owner asks for the business to be deleted: its exact name and the owner's password. */
export const RequestTenantDeletionBody = z.object({
  confirmName: z.string().trim().min(1, 'Type the business name').max(200),
  password: z.string().min(1, 'Password is required').max(128),
});
export type RequestTenantDeletionBody = z.infer<typeof RequestTenantDeletionBody>;

export const TenantDeletionStatus = z.object({
  businessName: z.string(),
  scheduled: z.boolean(),
  requestedAt: z.string().nullable(),
  /** When the business is deleted for good, unless the owner cancels before. */
  purgeAfter: z.string().nullable(),
  /** The grace period a new request would get, in days. */
  graceDays: z.number().int().min(1),
  /** The caller is an owner and the grace period has not ended: they can cancel now. */
  canCancel: z.boolean(),
});
export type TenantDeletionStatus = z.infer<typeof TenantDeletionStatus>;
