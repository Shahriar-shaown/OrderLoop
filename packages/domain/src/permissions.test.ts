import { Role } from '@orderloop/contracts';
import { describe, expect, it } from 'vitest';
import {
  can,
  canAssignRole,
  canManageMemberWithRole,
  permissionsFor,
  ROLE_PERMISSIONS,
} from './permissions.js';

const ROLES = Role.options;

describe('permissions', () => {
  it('defines every role', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...ROLES].sort());
  });
  it('owner and admin can do everything', () => {
    for (const role of ['OWNER', 'ADMIN'] as const)
      expect(permissionsFor(role)).toContain('members:manage');
  });
  it('staff cannot see members or audit logs', () => {
    expect(can('STAFF', 'members:read')).toBe(false);
    expect(can('STAFF', 'audit:read')).toBe(false);
  });
  it('only owner and admin can read audit logs or invite', () => {
    for (const role of ROLES) {
      const privileged = role === 'OWNER' || role === 'ADMIN';
      expect(can(role, 'audit:read')).toBe(privileged);
      expect(can(role, 'members:invite')).toBe(privileged);
    }
  });
});

describe('catalog and inventory permissions', () => {
  it('only OWNER, ADMIN and MANAGER may change the catalog', () => {
    for (const role of ROLES)
      expect(can(role, 'catalog:write'), role).toBe(['OWNER', 'ADMIN', 'MANAGER'].includes(role));
  });
  it('every role can read the catalog and stock', () => {
    for (const role of ROLES) {
      expect(can(role, 'catalog:read'), role).toBe(true);
      expect(can(role, 'inventory:read'), role).toBe(true);
    }
  });
  it('floor staff can move stock but accountants cannot', () => {
    expect(can('STAFF', 'inventory:write')).toBe(true);
    expect(can('ACCOUNTANT', 'inventory:write')).toBe(false);
  });
});

describe('role assignment', () => {
  it('owner can assign any role', () => {
    for (const target of ROLES) expect(canAssignRole('OWNER', target)).toBe(true);
  });
  it('admin cannot create owners or admins (no privilege escalation)', () => {
    expect(canAssignRole('ADMIN', 'OWNER')).toBe(false);
    expect(canAssignRole('ADMIN', 'ADMIN')).toBe(false);
    expect(canAssignRole('ADMIN', 'MANAGER')).toBe(true);
  });
  it('admin cannot modify or remove owners or other admins', () => {
    expect(canManageMemberWithRole('ADMIN', 'OWNER')).toBe(false);
    expect(canManageMemberWithRole('ADMIN', 'ADMIN')).toBe(false);
    expect(canManageMemberWithRole('ADMIN', 'STAFF')).toBe(true);
  });
  it('lower roles can assign and manage nothing', () => {
    for (const actor of ['MANAGER', 'STAFF', 'ACCOUNTANT'] as const) {
      for (const r of ROLES) {
        expect(canAssignRole(actor, r)).toBe(false);
        expect(canManageMemberWithRole(actor, r)).toBe(false);
      }
    }
  });
});
