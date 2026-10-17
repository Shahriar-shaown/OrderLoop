import type { Permission, Role } from '@orderloop/contracts';

const ALL: readonly Permission[] = [
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
];

/** What each role may do inside its tenant. Roles are per membership, never global. */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  OWNER: ALL,
  ADMIN: ALL,
  MANAGER: [
    'tenant:read',
    'members:read',
    'catalog:read',
    'catalog:write',
    'inventory:read',
    'inventory:write',
  ],
  // Floor staff look things up and move stock, but do not change the catalog.
  STAFF: ['tenant:read', 'catalog:read', 'inventory:read', 'inventory:write'],
  // Finance sees everything about products and stock, and changes none of it.
  ACCOUNTANT: ['tenant:read', 'members:read', 'catalog:read', 'inventory:read'],
};

export function permissionsFor(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Roles an ADMIN may hand out or change. Only an OWNER can create or alter owners and admins. */
const ADMIN_MANAGEABLE: readonly Role[] = ['MANAGER', 'STAFF', 'ACCOUNTANT'];

/** May `actor` grant `target` to someone (invite, or change a role to it)? */
export function canAssignRole(actor: Role, target: Role): boolean {
  if (actor === 'OWNER') return true;
  if (actor === 'ADMIN') return ADMIN_MANAGEABLE.includes(target);
  return false;
}

/** May `actor` change or remove a member who currently holds `current`? */
export function canManageMemberWithRole(actor: Role, current: Role): boolean {
  if (actor === 'OWNER') return true;
  if (actor === 'ADMIN') return ADMIN_MANAGEABLE.includes(current);
  return false;
}
