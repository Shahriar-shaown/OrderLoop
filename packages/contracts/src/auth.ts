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
]);
export type Permission = z.infer<typeof Permission>;

export const Uuid = z.string().uuid();
export const Email = z.string().trim().toLowerCase().email().max(254);
/** Length floor only (NIST 800-63B): no composition rules. 128 caps the hashing cost an attacker can force. */
export const Password = z.string().min(10, 'Use at least 10 characters').max(128);
const DisplayName = z.string().trim().min(1).max(100);

export const RegisterBody = z.object({
  email: Email,
  password: Password,
  name: DisplayName,
  tenantName: DisplayName,
});
export type RegisterBody = z.infer<typeof RegisterBody>;

export const LoginBody = z.object({
  email: Email,
  /** Not length-validated on purpose: login must not reveal the password policy. */
  password: z.string().min(1).max(128),
  /** Tenant to enter. Defaults to the most recently joined membership. */
  tenantId: Uuid.optional(),
});
export type LoginBody = z.infer<typeof LoginBody>;

export const RefreshBody = z.object({ refreshToken: z.string().min(1).max(512).optional() });
export type RefreshBody = z.infer<typeof RefreshBody>;

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
  user: z.object({ id: Uuid, email: z.string(), name: z.string() }),
  tenant: z.object({ id: Uuid, name: z.string() }),
  role: Role,
  memberships: z.array(MembershipSummary),
});
export type AuthResult = z.infer<typeof AuthResult>;

export const Me = z.object({
  user: z.object({ id: Uuid, email: z.string(), name: z.string() }),
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
  password: z.string().min(1).max(128),
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
