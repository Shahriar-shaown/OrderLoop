import { z } from 'zod';

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

export const RefreshBody = z.object({ refreshToken: z.string().min(1).max(512).optional() });
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

export const MembershipSummary = z.object({ tenantId: Uuid, role: Role });
export type MembershipSummary = z.infer<typeof MembershipSummary>;

export const AuthResult = z.object({
  accessToken: z.string(),
  /** Access-token lifetime in seconds. */
  expiresIn: z.number().int().positive(),
  /** Present for native clients. Web clients (header `x-client: web`) receive an HttpOnly cookie instead. */
  refreshToken: z.string().optional(),
  user: z.object({ id: Uuid, email: z.string(), name: z.string(), emailVerified: z.boolean() }),
  tenant: z.object({ id: Uuid, name: z.string() }),
  role: Role,
  memberships: z.array(MembershipSummary),
});
export type AuthResult = z.infer<typeof AuthResult>;

export const Me = z.object({
  user: z.object({ id: Uuid, email: z.string(), name: z.string(), emailVerified: z.boolean() }),
  tenant: z.object({ id: Uuid, name: z.string() }),
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

export const InviteBody = z.object({ email: Email, role: Role });
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

export const TenantInfo = z.object({ id: Uuid, name: z.string(), createdAt: z.string() });
export type TenantInfo = z.infer<typeof TenantInfo>;

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
