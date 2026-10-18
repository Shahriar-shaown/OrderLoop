import type { Invitation, Member } from '@orderloop/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mount } from '../../test/mount';
import { TeamScreen } from './TeamScreen';

const member = (id: string, name: string, role: Member['role'], userId = `u-${id}`): Member => ({
  id: `0197b0a0-0000-7000-8000-00000000000${id}`,
  userId,
  email: `${name.toLowerCase().replace(' ', '.')}@example.test`,
  name,
  role,
  joinedAt: '2026-10-01T00:00:00.000Z',
});
const people = [
  member('1', 'Anwar', 'OWNER', 'u'),
  member('2', 'Helper Person', 'STAFF'),
  member('3', 'Another Admin', 'ADMIN'),
];
const invitation: Invitation & { invitedById: string; createdAt: string } = {
  id: '0197b0a0-0000-7000-8000-0000000000b1',
  email: 'new.person@example.test',
  role: 'MANAGER',
  expiresAt: '2026-10-30T00:00:00.000Z',
  invitedById: 'u',
  createdAt: '2026-10-18T00:00:00.000Z',
};
const api = (extra: Record<string, unknown> = {}) => ({
  members: {
    list: async () => people,
    listInvitations: async () => [invitation],
    invite: vi.fn(async () => ({})),
    updateRole: vi.fn(async () => ({})),
    remove: vi.fn(async () => ({})),
    revokeInvitation: vi.fn(async () => ({})),
    ...extra,
  },
  auditLogs: {
    list: async () => ({
      items: [
        {
          id: '0197b0a0-0000-7000-8000-0000000000c1',
          action: 'member.invited',
          actorUserId: 'u',
          targetType: 'invitation',
          targetId: null,
          createdAt: '2026-10-18T00:00:00.000Z',
        },
      ],
      nextCursor: null,
    }),
  },
});

describe('team and permissions', () => {
  it('shows the people, the pending invitations and the real permission matrix', async () => {
    mount(<TeamScreen />, api());
    expect(await screen.findByText('Helper Person')).toBeTruthy();
    expect(screen.getByText('new.person@example.test')).toBeTruthy();
    expect(screen.getByText(/^Your role: Owner\./)).toBeTruthy();
    const matrix = screen.getByRole('table', { name: 'Permissions by role' });
    const settings = within(matrix).getByRole('row', { name: /Change business settings/ });
    const cells = within(settings)
      .getAllByRole('cell')
      .map((c) => c.textContent);
    expect(cells.slice(1)).toEqual(['Yes', 'Yes', 'No', 'No', 'No']); // owner, admin, manager, staff, accountant
    const orders = within(matrix).getByRole('row', { name: /Create and change orders/ });
    expect(
      within(orders)
        .getAllByRole('cell')
        .map((c) => c.textContent)
        .slice(1),
    ).toEqual(['Yes', 'Yes', 'Yes', 'Yes', 'No']);
    expect(await screen.findByText('member.invited')).toBeTruthy();
  });

  it('validates an invitation before sending, then sends it', async () => {
    const a = api();
    mount(<TeamScreen />, a);
    await userEvent.click(await screen.findByRole('button', { name: 'Invite someone' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Email/), 'nope');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    expect(await within(dialog).findByText('Enter a valid email address')).toBeTruthy();
    expect(a.members.invite).not.toHaveBeenCalled();
    await userEvent.clear(within(dialog).getByLabelText(/Email/));
    await userEvent.type(within(dialog).getByLabelText(/Email/), 'friend@example.test');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    await waitFor(() =>
      expect(a.members.invite).toHaveBeenCalledWith({
        email: 'friend@example.test',
        role: 'STAFF',
      }),
    );
  });

  it('asks before removing someone, and does nothing if you back out', async () => {
    const a = api();
    mount(<TeamScreen />, a);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Helper Person' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/They lose access to this business immediately/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(a.members.remove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Helper Person' }));
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }),
    );
    await waitFor(() => expect(a.members.remove).toHaveBeenCalledWith(people[1]!.id));
  });

  it('asks before revoking an invitation', async () => {
    const a = api();
    mount(<TeamScreen />, a);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Revoke invitation for new.person@example.test' }),
    );
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke' }),
    );
    await waitFor(() => expect(a.members.revokeInvitation).toHaveBeenCalledWith(invitation.id));
  });

  it('changes a role through a dialog, and offers no actions on yourself', async () => {
    const a = api();
    mount(<TeamScreen />, a);
    await screen.findByText('Helper Person');
    expect(screen.queryByRole('button', { name: 'Change role for Anwar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove Anwar' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Change role for Helper Person' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(
      within(dialog).getByLabelText('Role', { exact: true }),
      'MANAGER',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save role' }));
    await waitFor(() =>
      expect(a.members.updateRole).toHaveBeenCalledWith(people[1]!.id, 'MANAGER'),
    );
  });

  it('an admin cannot manage owners or other admins, and cannot grant those roles', async () => {
    mount(<TeamScreen />, api(), 'ADMIN');
    await screen.findByText('Helper Person');
    expect(screen.getByRole('button', { name: 'Change role for Helper Person' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Change role for Another Admin' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Invite someone' }));
    const options = within(await screen.findByRole('dialog'))
      .getAllByRole('option')
      .map((o) => o.textContent ?? '');
    expect(options.some((o) => o.startsWith('Owner'))).toBe(false);
    expect(options.some((o) => o.startsWith('Admin'))).toBe(false);
    expect(options.some((o) => o.startsWith('Manager'))).toBe(true);
  });

  it('a role without team access sees the explanation and the matrix, not the people', async () => {
    mount(<TeamScreen />, api(), 'STAFF');
    expect(await screen.findByText('Your role cannot see the team list.')).toBeTruthy();
    expect(screen.queryByText('Helper Person')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Invite someone' })).toBeNull();
    expect(screen.getByRole('table', { name: 'Permissions by role' })).toBeTruthy();
  });
});
