import {
  InviteBody,
  Role as RoleSchema,
  type Invitation,
  type Member,
  type Permission,
  type Role,
} from '@orderloop/contracts';
import { canAssignRole, canManageMemberWithRole, ROLE_PERMISSIONS } from '@orderloop/domain';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FieldGrid,
  FormDialog,
  Icon,
  Menu,
  PageHeader,
  Row,
  Section,
  SelectField,
  Stack,
  TableSection,
  Text,
  TextField,
  useBreakpoint,
  useTheme,
  useToast,
  type Column,
  type Tone,
} from '@orderloop/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../../core/auth';
import { QueryBoundary } from '../../shell/QueryBoundary';
import { validate } from '../../forms/errors';
import { messageFor } from '../../forms/errors';
import { formatWhen } from '../../lib/format';
import { useFormState } from '../../forms/forms';
import { useCan } from '../../core/permissions';
import { useApi } from '../../core/runtime';

const ROLE_VALUES = RoleSchema.options;

const ROLE_LABEL: Record<Role, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  STAFF: 'Staff',
  ACCOUNTANT: 'Accountant',
};
const ROLE_TONE: Record<Role, Tone> = {
  OWNER: 'brand',
  ADMIN: 'info',
  MANAGER: 'success',
  STAFF: 'neutral',
  ACCOUNTANT: 'warning',
};
const ROLE_NOTE: Record<Role, string> = {
  OWNER: 'Everything, including other owners and admins.',
  ADMIN: 'Everything except changing owners and admins.',
  MANAGER: 'Runs the catalog, stock and orders. Cannot manage the team or settings.',
  STAFF: 'Takes and processes orders and moves stock. Cannot change the catalog.',
  ACCOUNTANT: 'Can look at products, stock and orders, and change nothing.',
};

/** What each permission means to a person, in the order a seller thinks of them. */
const CAPABILITIES: { permission: Permission; label: string }[] = [
  { permission: 'orders:read', label: 'See orders and customers' },
  { permission: 'orders:write', label: 'Create and change orders and customers' },
  { permission: 'catalog:read', label: 'See products and suppliers' },
  { permission: 'catalog:write', label: 'Change products, categories, suppliers and imports' },
  { permission: 'inventory:read', label: 'See stock' },
  { permission: 'inventory:write', label: 'Receive, adjust and move stock' },
  { permission: 'tenant:read', label: 'See business settings' },
  { permission: 'tenant:update', label: 'Change business settings' },
  { permission: 'members:read', label: 'See the team' },
  { permission: 'members:invite', label: 'Invite people' },
  { permission: 'members:manage', label: 'Change roles and remove people' },
  { permission: 'audit:read', label: 'See the audit log' },
];

/** Invite someone by email with a role: validated with the API's own rules before it is sent. */
function InviteSection({ assignable }: { assignable: Role[] }) {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const form = useFormState({
    email: '',
    role: assignable.includes('STAFF') ? 'STAFF' : (assignable[0] ?? 'STAFF'),
  });
  async function submit() {
    const checked = validate(InviteBody, { email: form.values.email, role: form.values.role });
    form.setFormError('');
    if (!checked.data) return form.setErrors(checked.errors ?? {});
    const body = checked.data;
    const ok = await form.run(async () => {
      await api.members.invite(body);
      await queryClient.invalidateQueries({ queryKey: ['invitations'] });
    });
    if (ok) {
      toast.success(`Invitation sent to ${body.email}`);
      form.set('email', '');
    }
  }
  return (
    <Section
      title="Invite someone"
      description="They get a link by email that is valid for a few days."
    >
      <Stack gap={4}>
        {form.formError ? <Alert tone="error">{form.formError}</Alert> : null}
        <FieldGrid minWidth={240}>
          <TextField
            label="Email"
            kind="email"
            required
            leadingIcon="message"
            {...form.field('email')}
          />
          <SelectField
            label="Role"
            options={assignable.map((r) => ({
              value: r,
              label: `${ROLE_LABEL[r]}: ${ROLE_NOTE[r]}`,
            }))}
            value={form.values.role}
            onChange={(v) => form.set('role', v)}
            error={form.errors.role}
          />
        </FieldGrid>
        <Row>
          <Button icon="plus" loading={form.busy} onPress={submit}>
            Send invitation
          </Button>
        </Row>
      </Stack>
    </Section>
  );
}

function RoleDialog({
  member,
  assignable,
  onClose,
}: {
  member: Member | null;
  assignable: Role[];
  onClose: () => void;
}) {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const form = useFormState({ role: member?.role ?? 'STAFF' });
  if (!member) return null;
  async function submit() {
    const role = form.values.role as Role;
    if (role === member!.role) return onClose();
    const ok = await form.run(async () => {
      await api.members.updateRole(member!.id, role);
      await queryClient.invalidateQueries({ queryKey: ['members'] });
    });
    if (ok) {
      toast.success(`${member!.name} is now ${ROLE_LABEL[role].toLowerCase()}`);
      onClose();
    }
  }
  return (
    <FormDialog
      open
      onClose={onClose}
      title={`Change role for ${member.name}`}
      onSubmit={submit}
      submitLabel="Save role"
      busy={form.busy}
      error={form.formError}
      size="sm"
    >
      <SelectField
        label="Role"
        options={assignable.map((r) => ({ value: r, label: `${ROLE_LABEL[r]}: ${ROLE_NOTE[r]}` }))}
        value={form.values.role}
        onChange={(v) => form.set('role', v)}
      />
      <Text variant="caption" tone="muted">
        The change applies on their very next action.
      </Text>
    </FormDialog>
  );
}

/** A person's initials, name and email, with a "You" marker on your own row. */
function Person({ member, you }: { member: Member; you: boolean }) {
  return (
    <Row gap={3}>
      <Avatar name={member.name} size={36} />
      <Stack gap={1} style={{ flexShrink: 1 }}>
        <Row gap={2} wrap>
          <Text weight="medium">{member.name}</Text>
          {you && <Badge tone="info">You</Badge>}
        </Row>
        <Text variant="caption" tone="muted">
          {member.email}
        </Text>
      </Stack>
    </Row>
  );
}

type Capability = (typeof CAPABILITIES)[number];

/** Whether a role has a permission, as an icon with a word for assistive technology. */
function Has({ yes }: { yes: boolean }) {
  const { colors } = useTheme();
  return yes ? (
    <Icon name="check" size={18} color={colors.tones.success.text} label="Yes" />
  ) : (
    <Icon name="minus" size={18} color={colors.muted} label="No" />
  );
}

export function TeamScreen() {
  const api = useApi();
  const can = useCan();
  const { session } = useAuth();
  const { isMobile } = useBreakpoint();
  const toast = useToast();
  const queryClient = useQueryClient();
  const myRole = session?.role ?? 'STAFF';
  const assignable = ROLE_VALUES.filter((r) => canAssignRole(myRole, r));
  const [editing, setEditing] = useState<Member | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const [busy, setBusy] = useState(false);

  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => api.members.list(),
    enabled: can('members:read'),
  });
  const invitations = useQuery({
    queryKey: ['invitations'],
    queryFn: () => api.members.listInvitations(),
    enabled: can('members:invite'),
  });
  const activity = useQuery({
    queryKey: ['auditLogs', 'team'],
    queryFn: () => api.auditLogs.list({ limit: 10 }),
    enabled: can('audit:read'),
  });
  const names = new Map((members.data ?? []).map((m) => [m.userId, m.name]));

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await action();
      await Promise.all(
        ['members', 'invitations', 'auditLogs'].map((k) =>
          queryClient.invalidateQueries({ queryKey: [k] }),
        ),
      );
      toast.success(done);
      setRemoving(null);
      setRevoking(null);
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(false);
    }
  }

  const canActOn = (m: Member) =>
    can('members:manage') &&
    m.userId !== session?.user.id &&
    canManageMemberWithRole(myRole, m.role);
  const memberMenu = (m: Member) =>
    canActOn(m) ? (
      <Menu
        label={`Actions for ${m.name}`}
        items={[
          { key: 'role', label: 'Change role', icon: 'edit', onPress: () => setEditing(m) },
          {
            key: 'remove',
            label: 'Remove',
            icon: 'trash',
            danger: true,
            onPress: () => setRemoving(m),
          },
        ]}
      />
    ) : null;

  const revokeButton = (invitation: Invitation) => (
    <Button
      size="sm"
      variant="secondary"
      icon="trash"
      accessibilityLabel={`Revoke invitation for ${invitation.email}`}
      onPress={() => setRevoking(invitation)}
    >
      Revoke
    </Button>
  );

  const memberColumns: Column<Member>[] = [
    {
      key: 'name',
      header: 'Person',
      flex: 3,
      minWidth: 240,
      render: (m) => <Person member={m} you={m.userId === session?.user.id} />,
    },
    {
      key: 'role',
      header: 'Role',
      minWidth: 110,
      render: (m) => <Badge tone={ROLE_TONE[m.role]}>{ROLE_LABEL[m.role]}</Badge>,
    },
    {
      key: 'joined',
      header: 'Joined',
      flex: 2,
      minWidth: 150,
      show: 'wide',
      render: (m) => formatWhen(m.joinedAt),
    },
    ...(can('members:manage')
      ? [
          {
            key: 'actions',
            header: 'Actions',
            align: 'right' as const,
            minWidth: 90,
            render: (m: Member) => memberMenu(m),
          },
        ]
      : []),
  ];

  const inviteColumns: Column<Invitation>[] = [
    { key: 'email', header: 'Invited', flex: 3, minWidth: 220, render: (i) => i.email },
    {
      key: 'role',
      header: 'Role',
      minWidth: 110,
      render: (i) => <Badge tone={ROLE_TONE[i.role]}>{ROLE_LABEL[i.role]}</Badge>,
    },
    {
      key: 'exp',
      header: 'Expires',
      flex: 2,
      minWidth: 150,
      show: 'wide',
      render: (i) => formatWhen(i.expiresAt),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      minWidth: 120,
      render: (i) => revokeButton(i),
    },
  ];

  const matrixColumns: Column<Capability>[] = [
    { key: 'cap', header: 'Can…', flex: 4, minWidth: 260, render: (c) => c.label },
    ...ROLE_VALUES.map((r) => ({
      key: r,
      header: ROLE_LABEL[r],
      align: 'right' as const,
      minWidth: 96,
      render: (c: Capability) => <Has yes={ROLE_PERMISSIONS[r].includes(c.permission)} />,
    })),
  ];

  return (
    <Stack gap={isMobile ? 4 : 6}>
      <PageHeader
        title="Team & staff"
        description="Who can do what in this business. Roles apply only here: the same person can have a different role in another business."
      />
      <Alert tone="info">{`Your role: ${ROLE_LABEL[myRole]}. ${ROLE_NOTE[myRole]}`}</Alert>

      {can('members:invite') && assignable.length > 0 && <InviteSection assignable={assignable} />}

      {can('members:read') ? (
        <TableSection title="Team members" description="Everyone with access to this business.">
          <QueryBoundary {...members} refetch={() => members.refetch()} label="Loading the team">
            <DataTable
              label="Team members"
              columns={memberColumns}
              rows={members.data ?? []}
              rowKey={(m) => m.id}
              renderCard={(m) => (
                <Row justify="between" align="start" gap={2}>
                  <Stack gap={2} grow>
                    <Person member={m} you={m.userId === session?.user.id} />
                    <Row gap={2} wrap>
                      <Badge tone={ROLE_TONE[m.role]}>{ROLE_LABEL[m.role]}</Badge>
                      <Text variant="caption" tone="muted">
                        {`Joined ${formatWhen(m.joinedAt)}`}
                      </Text>
                    </Row>
                  </Stack>
                  {memberMenu(m)}
                </Row>
              )}
            />
          </QueryBoundary>
        </TableSection>
      ) : (
        <Alert tone="warning">Your role cannot see the team list.</Alert>
      )}

      {can('members:invite') && (
        <TableSection
          title="Pending invitations"
          description="People invited who have not joined yet."
        >
          <QueryBoundary
            {...invitations}
            refetch={() => invitations.refetch()}
            label="Loading invitations"
          >
            {(invitations.data ?? []).length === 0 ? (
              <EmptyState title="No pending invitations" icon="clock">
                Invite a team member and they will appear here until they join.
              </EmptyState>
            ) : (
              <DataTable
                label="Pending invitations"
                columns={inviteColumns}
                rows={invitations.data ?? []}
                rowKey={(i) => i.id}
                renderCard={(i) => (
                  <Stack gap={2}>
                    <Text weight="medium">{i.email}</Text>
                    <Row gap={2} wrap justify="between">
                      <Row gap={2} wrap>
                        <Badge tone={ROLE_TONE[i.role]}>{ROLE_LABEL[i.role]}</Badge>
                        <Text variant="caption" tone="muted">
                          {`Expires ${formatWhen(i.expiresAt)}`}
                        </Text>
                      </Row>
                      {revokeButton(i)}
                    </Row>
                  </Stack>
                )}
              />
            )}
          </QueryBoundary>
        </TableSection>
      )}

      <TableSection
        title="What each role can do"
        description="The same rules are enforced by the server on every request, not just hidden here."
      >
        <DataTable
          label="Permissions by role"
          columns={matrixColumns}
          rows={CAPABILITIES}
          rowKey={(c) => c.permission}
          rowHeight={48}
          renderCard={(c) => (
            <Stack gap={2}>
              <Text weight="medium">{c.label}</Text>
              <Row gap={1} wrap>
                {ROLE_VALUES.filter((r) => ROLE_PERMISSIONS[r].includes(c.permission)).map((r) => (
                  <Badge key={r} tone={ROLE_TONE[r]}>
                    {ROLE_LABEL[r]}
                  </Badge>
                ))}
              </Row>
            </Stack>
          )}
        />
        <Stack gap={1}>
          {ROLE_VALUES.map((r) => (
            <Text
              key={r}
              variant="caption"
              tone="muted"
            >{`${ROLE_LABEL[r]}: ${ROLE_NOTE[r]}`}</Text>
          ))}
        </Stack>
      </TableSection>

      {can('audit:read') && (
        <Section
          title="Recent administrative activity"
          description="Sign-ins to a business, role changes, invitations, settings and stock or order actions."
        >
          <QueryBoundary {...activity} refetch={() => activity.refetch()} label="Loading activity">
            {(activity.data?.items ?? []).length === 0 ? (
              <Text tone="muted">Nothing recorded yet.</Text>
            ) : (
              <Stack gap={2}>
                {(activity.data?.items ?? []).map((a) => (
                  <Row key={a.id} gap={2} wrap>
                    <Text weight="medium">{a.action}</Text>
                    <Text variant="caption" tone="muted">
                      {`${formatWhen(a.createdAt)}${a.actorUserId ? ` · ${names.get(a.actorUserId) ?? 'someone'}` : ''}`}
                    </Text>
                  </Row>
                ))}
              </Stack>
            )}
          </QueryBoundary>
        </Section>
      )}

      <RoleDialog
        key={editing?.id ?? 'none'}
        member={editing}
        assignable={assignable}
        onClose={() => setEditing(null)}
      />
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.name ?? ''}?`}
        confirmLabel="Remove"
        danger
        busy={busy}
        onClose={() => setRemoving(null)}
        onConfirm={() =>
          removing && run(() => api.members.remove(removing.id), `${removing.name} was removed`)
        }
      >
        They lose access to this business immediately. Their past work stays in the history.
      </ConfirmDialog>
      <ConfirmDialog
        open={revoking !== null}
        title="Revoke this invitation?"
        confirmLabel="Revoke"
        danger
        busy={busy}
        onClose={() => setRevoking(null)}
        onConfirm={() =>
          revoking && run(() => api.members.revokeInvitation(revoking.id), 'Invitation revoked')
        }
      >
        {`The link sent to ${revoking?.email ?? 'them'} stops working.`}
      </ConfirmDialog>
    </Stack>
  );
}
