import { z } from 'zod';
import { OptionalIdempotencyKey } from './idempotency.js';

export const Role = z.enum(['OWNER', 'ADMIN', 'MANAGER', 'STAFF', 'ACCOUNTANT']);
export type Role = z.infer<typeof Role>;

export const Permission = z.enum([
  'tenant:read',
  'tenant:update',
  'members:read',
  'members:invite',
  'members:manage',
  'audit:read',
  'catalog:read',
  'catalog:write',
  'inventory:read',
  'inventory:write',
  'orders:read',
  'orders:write',
  'couriers:read',
  'couriers:manage',
  'finance:read',
  'finance:import',
  'finance:adjust',
  'automation:read',
  'automation:manage',
]);
export type Permission = z.infer<typeof Permission>;

export const Uuid = z.string().uuid();
export const Email = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Email is required')
  .email('Enter a valid email address')
  .max(254, 'Email is too long');
/**
 * The rule for choosing a password (sign-up, reset, invitation): 8 to 128 characters with an uppercase letter, a number and
 * a special character. 128 caps the hashing cost an attacker can force. Sign-in does not apply it (see LoginBody).
 */
export const Password = z
  .string()
  .min(1, 'Password is required')
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[A-Z]/, 'Password must include an uppercase letter')
  .regex(/[0-9]/, 'Password must include a number')
  .regex(/[^A-Za-z0-9]/, 'Password must include a special character');

// Names are shown to other people. Reject control and formatting characters (line breaks, zero-width, bidi overrides).
const displayName = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .min(3, `${label} must be at least 3 characters`)
    .max(100, `${label} must be at most 100 characters`)
    .refine(
      (v) => !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(v),
      `${label} contains characters that are not allowed`,
    );
const DisplayName = displayName('Name');

export const RegisterBody = z.object({
  email: Email,
  password: Password,
  name: DisplayName,
  tenantName: displayName('Business name'),
});
export type RegisterBody = z.infer<typeof RegisterBody>;

export const LoginBody = z.object({
  email: Email,
  /** Not length-validated on purpose: login must not reveal the password policy. */
  password: z.string().min(1, 'Password is required').max(128),
  /** Tenant to enter. Defaults to the most recently joined membership. */
  tenantId: Uuid.optional(),
});
export type LoginBody = z.infer<typeof LoginBody>;

export const RefreshBody = z.object({
  refreshToken: z.string().min(1).max(512).optional(),
  /**
   * The tenant this client believes it is in. When the session being refreshed belongs to another tenant (a second
   * tab switched, and the shared web cookie now holds that session), the answer is 409 `tenant_changed` and nothing rotates.
   */
  expectedTenantId: Uuid.optional(),
});
export type RefreshBody = z.infer<typeof RefreshBody>;

const OneTimeToken = z.string().min(20).max(512);

export const VerifyEmailBody = z.object({ token: OneTimeToken });
export type VerifyEmailBody = z.infer<typeof VerifyEmailBody>;

export const ForgotPasswordBody = z.object({ email: Email });
export type ForgotPasswordBody = z.infer<typeof ForgotPasswordBody>;

export const ResetPasswordBody = z.object({ token: OneTimeToken, password: Password });
export type ResetPasswordBody = z.infer<typeof ResetPasswordBody>;

export const SwitchTenantBody = z.object({ tenantId: Uuid });
export type SwitchTenantBody = z.infer<typeof SwitchTenantBody>;

export const Language = z.enum(['en', 'bn']);
export type Language = z.infer<typeof Language>;

/** Currencies a business can report in. Amounts are stored in minor units regardless. */
export const CURRENCIES = ['BDT', 'USD', 'INR', 'EUR', 'GBP', 'AED', 'SAR', 'MYR', 'SGD'] as const;
export const Currency = z.enum(CURRENCIES);
export type Currency = z.infer<typeof Currency>;

/** IANA zones offered in the settings screens. An allowlist keeps clients (including Hermes) from needing full Intl data. */
export const TIMEZONES = [
  'Asia/Dhaka',
  'Asia/Kolkata',
  'Asia/Karachi',
  'Asia/Dubai',
  'Asia/Riyadh',
  'Asia/Kuala_Lumpur',
  'Asia/Singapore',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'UTC',
] as const;
export const Timezone = z.enum(TIMEZONES);
export type Timezone = z.infer<typeof Timezone>;

export const DEFAULT_CURRENCY = 'BDT' satisfies Currency;
export const DEFAULT_TIMEZONE = 'Asia/Dhaka' satisfies Timezone;

const BusinessName = displayName('Business name');
const LogoUrl = z
  .string()
  .trim()
  .max(2048, 'Logo link is too long')
  .url('Enter a valid link')
  .refine((v) => v.startsWith('https://'), 'Logo link must start with https://');
const Phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9 ()-]{5,19}$/, 'Enter a valid phone number');
const optionalText = (label: string, max: number) =>
  z.string().trim().min(1, `${label} cannot be empty`).max(max, `${label} is too long`);

export const MembershipSummary = z.object({ tenantId: Uuid, role: Role });
export type MembershipSummary = z.infer<typeof MembershipSummary>;

export const UserSummary = z.object({
  id: Uuid,
  email: z.string(),
  name: z.string(),
  emailVerified: z.boolean(),
  language: Language,
});
export type UserSummary = z.infer<typeof UserSummary>;

/** The business the session is currently working in, with the settings every screen formats by. */
export const TenantSummary = z.object({
  id: Uuid,
  name: z.string(),
  logoUrl: z.string().nullable(),
  currency: Currency,
  timezone: Timezone,
  defaultLanguage: Language,
});
export type TenantSummary = z.infer<typeof TenantSummary>;

export const AuthResult = z.object({
  accessToken: z.string(),
  /** Access-token lifetime in seconds. */
  expiresIn: z.number().int().positive(),
  /** Present for native clients. Web clients (header `x-client: web`) receive an HttpOnly cookie instead. */
  refreshToken: z.string().optional(),
  user: UserSummary,
  tenant: TenantSummary,
  role: Role,
  memberships: z.array(MembershipSummary),
});
export type AuthResult = z.infer<typeof AuthResult>;

export const Me = z.object({
  user: UserSummary,
  tenant: TenantSummary,
  role: Role,
  permissions: z.array(Permission),
  memberships: z.array(MembershipSummary),
});
export type Me = z.infer<typeof Me>;

export const Member = z.object({
  id: Uuid,
  userId: Uuid,
  email: z.string(),
  name: z.string(),
  role: Role,
  joinedAt: z.string(),
});
export type Member = z.infer<typeof Member>;

export const InviteBody = z.object({ email: Email, role: Role, ...OptionalIdempotencyKey });
export type InviteBody = z.infer<typeof InviteBody>;

export const Invitation = z.object({
  id: Uuid,
  email: z.string(),
  role: Role,
  expiresAt: z.string(),
});
export type Invitation = z.infer<typeof Invitation>;

export const InvitationSummary = Invitation.extend({ invitedById: Uuid, createdAt: z.string() });
export type InvitationSummary = z.infer<typeof InvitationSummary>;

export const AcceptInvitationBody = z.object({
  token: z.string().min(1).max(512),
  /** Required when creating a new account; ignored when the invited email already has one. */
  name: DisplayName.optional(),
  password: z.string().min(1, 'Password is required').max(128),
});
export type AcceptInvitationBody = z.infer<typeof AcceptInvitationBody>;

export const UpdateMemberBody = z.object({ role: Role });
export type UpdateMemberBody = z.infer<typeof UpdateMemberBody>;

export const TenantInfo = TenantSummary.extend({
  createdAt: z.string(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  district: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string(),
});
export type TenantInfo = z.infer<typeof TenantInfo>;

/** A business the signed-in user belongs to, with their role in it (the workspace switcher list). */
export const Workspace = TenantSummary.extend({ role: Role, joinedAt: z.string() });
export type Workspace = z.infer<typeof Workspace>;

export const CreateWorkspaceBody = z.object({
  name: BusinessName,
  currency: Currency.default(DEFAULT_CURRENCY),
  timezone: Timezone.default(DEFAULT_TIMEZONE),
  defaultLanguage: Language.default('en'),
  ...OptionalIdempotencyKey,
});
export type CreateWorkspaceBody = z.input<typeof CreateWorkspaceBody>;

/** Partial update. `null` clears an optional field; a field left out is unchanged. */
export const UpdateTenantBody = z
  .object({
    name: BusinessName,
    logoUrl: LogoUrl.nullable(),
    contactEmail: Email.nullable(),
    contactPhone: Phone.nullable(),
    addressLine1: optionalText('Address', 200).nullable(),
    addressLine2: optionalText('Address', 200).nullable(),
    city: optionalText('City', 100).nullable(),
    district: optionalText('District', 100).nullable(),
    postalCode: optionalText('Postal code', 20).nullable(),
    country: z.string().regex(/^[A-Z]{2}$/, 'Use a two-letter country code'),
    currency: Currency,
    timezone: Timezone,
    defaultLanguage: Language,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateTenantBody = z.infer<typeof UpdateTenantBody>;

export const UpdatePreferencesBody = z.object({ language: Language });
export type UpdatePreferencesBody = z.infer<typeof UpdatePreferencesBody>;

export const AuditEntry = z.object({
  id: Uuid,
  action: z.string(),
  actorUserId: Uuid.nullable(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  createdAt: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const AuditPage = z.object({
  items: z.array(AuditEntry),
  nextCursor: z.string().nullable(),
});
export type AuditPage = z.infer<typeof AuditPage>;

export const AuditQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type AuditQuery = z.infer<typeof AuditQuery>;

export const IdParam = z.object({ id: Uuid });
export const Empty = z.object({}).strict();
