import type {
  CourierCheck,
  CourierEntry,
  CourierEnvironment,
  CourierSettings,
  SaveCourierBody,
} from '@orderloop/contracts';
import {
  Alert,
  Button,
  ConfirmDialog,
  Row,
  SelectField,
  Stack,
  Text,
  TextField,
  useToast,
} from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ENVIRONMENT_LABEL, MOCK_OUTCOME_OPTIONS } from '../couriers';
import { messageFor } from '../errors';
import { formatWhen } from '../format';
import { useFormState } from '../forms';
import { useApi } from '../runtime';

const yesNo = (v: boolean | undefined) => (v ? 'yes' : 'no');

/** The settings of one courier connection: what it can do, its last check, and the form to save, test and disconnect it. */
export function CourierConnectionForm({
  entry,
  canManage,
}: {
  entry: CourierEntry;
  canManage: boolean;
}) {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const c = entry.connection;
  const [check, setCheck] = useState<CourierCheck | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const s = c?.settings ?? {};
  const form = useFormState({
    environment: c?.environment ?? entry.environments[0] ?? 'simulated',
    // Secrets are never sent back, so these start empty. Leaving one empty keeps what is saved.
    ...Object.fromEntries(entry.credentialFields.map((f) => [f.key, ''])),
    webhookSecret: '',
    storeId: s.storeId ? String(s.storeId) : '',
    deliveryType: String(s.deliveryType ?? 48),
    itemType: String(s.itemType ?? 2),
    defaultWeightKg: s.defaultWeightKg ? String(s.defaultWeightKg) : '',
    host: s.host ?? 'steadfast',
    outcome: s.outcome ?? 'success',
    referenceLookup: yesNo(s.referenceLookup),
  } as Record<string, string>);

  const connected = !!c && c.enabled && (entry.simulated || c.hasCredentials);
  const v = form.values;

  function buildBody(): SaveCourierBody {
    const credentials = Object.fromEntries(
      entry.credentialFields.map((f) => [f.key, v[f.key]?.trim()]).filter(([, val]) => val),
    );
    const settings: CourierSettings = {};
    if (entry.provider === 'pathao') {
      if (v.storeId?.trim()) settings.storeId = Number(v.storeId);
      settings.deliveryType = v.deliveryType === '12' ? 12 : 48;
      settings.itemType = v.itemType === '1' ? 1 : 2;
      if (v.defaultWeightKg?.trim()) settings.defaultWeightKg = Number(v.defaultWeightKg);
    }
    if (entry.provider === 'steadfast')
      settings.host = v.host === 'packzy' ? 'packzy' : 'steadfast';
    if (entry.provider === 'mock') {
      settings.outcome = v.outcome as NonNullable<CourierSettings['outcome']>;
      settings.referenceLookup = v.referenceLookup === 'yes';
    }
    return {
      environment: v.environment as CourierEnvironment,
      ...(Object.keys(credentials).length ? { credentials } : {}),
      ...(v.webhookSecret?.trim() ? { webhookSecret: v.webhookSecret.trim() } : {}),
      settings,
      enabled: true,
    };
  }

  async function save() {
    setBusy('save');
    setCheck(null);
    const ok = await form.run(async () => {
      await api.couriers.save(entry.provider, buildBody());
      await queryClient.invalidateQueries({ queryKey: ['couriers'] });
    });
    setBusy(null);
    if (ok) {
      // The secrets are on the server now; clear the boxes so they are not left on screen.
      for (const f of entry.credentialFields) form.set(f.key, '');
      form.set('webhookSecret', '');
      toast.success(`${entry.name} saved`);
    }
  }

  async function test() {
    setBusy('test');
    try {
      setCheck(await api.couriers.test(entry.provider));
      await queryClient.invalidateQueries({ queryKey: ['couriers'] });
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy('remove');
    try {
      await api.couriers.remove(entry.provider);
      await queryClient.invalidateQueries({ queryKey: ['couriers'] });
      toast.success(`${entry.name} disconnected`);
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(null);
    }
  }

  const caps = entry.capabilities;
  return (
    <Stack gap={4}>
      {!entry.available && <Alert tone="warning">{entry.unavailableReason}</Alert>}

      {!entry.simulated && (
        <Text tone="muted" variant="caption">
          {[
            caps.quote ? 'Delivery fee estimate' : 'No fee estimate before booking',
            caps.cancel ? 'Cancel from here' : 'Cancel in the courier’s own panel',
            caps.webhooks ? 'Pushes status updates (webhook)' : 'No webhook',
            caps.duplicateProtection === 'reference'
              ? 'Can look a booking up by our reference'
              : 'Cannot look up a booking: an unconfirmed one needs a person',
          ].join(' · ')}
        </Text>
      )}

      {c?.lastCheckedAt && (
        <Alert tone={c.lastCheckOk ? 'success' : 'error'}>
          {`Last checked ${formatWhen(c.lastCheckedAt)}: ${c.lastCheckOk ? 'it works' : (c.lastCheckMessage ?? 'it failed')}`}
        </Alert>
      )}
      {check && (
        <Alert
          tone={check.ok ? 'success' : 'error'}
          title={check.ok ? 'Connection works' : 'Connection failed'}
        >
          <Stack gap={1}>
            {check.ok ? (
              check.details.map((d) => <Text key={d}>{d}</Text>)
            ) : (
              <Text>{check.message}</Text>
            )}
          </Stack>
        </Alert>
      )}

      {canManage && entry.available && (
        <Stack gap={3}>
          {form.formError ? <Alert tone="error">{form.formError}</Alert> : null}

          {entry.environments.length > 1 && (
            <SelectField
              label="Which account"
              value={v.environment ?? ''}
              onChange={(val) => form.set('environment', val)}
              options={entry.environments.map((e) => ({ value: e, label: ENVIRONMENT_LABEL[e] }))}
            />
          )}

          {entry.credentialFields.map((f) => (
            <TextField
              key={f.key}
              label={f.label}
              kind="password"
              required={!f.optional && !c?.hasCredentials}
              hint={
                c?.hasCredentials
                  ? 'Saved. Leave empty to keep it. It is never shown again.'
                  : 'Stored encrypted on the server. Never shown again.'
              }
              autoComplete="off"
              {...form.field(f.key)}
            />
          ))}

          {entry.provider === 'pathao' && (
            <>
              <TextField
                label="Pathao store ID"
                keyboardType="number-pad"
                hint="The store parcels are collected from (the connection test lists yours)."
                {...form.field('storeId')}
              />
              <SelectField
                label="Delivery type"
                value={v.deliveryType ?? '48'}
                onChange={(val) => form.set('deliveryType', val)}
                options={[
                  { value: '48', label: 'Normal (48 hours)' },
                  { value: '12', label: 'On demand (12 hours)' },
                ]}
              />
              <TextField
                label="Default parcel weight in kg"
                keyboardType="decimal-pad"
                hint="Between 0.5 and 10. Used when an order does not say."
                {...form.field('defaultWeightKg')}
              />
            </>
          )}
          {entry.provider === 'steadfast' && (
            <SelectField
              label="Steadfast address"
              value={v.host ?? 'steadfast'}
              onChange={(val) => form.set('host', val)}
              options={[
                { value: 'steadfast', label: 'portal.steadfast.com.bd' },
                { value: 'packzy', label: 'portal.packzy.com (older address)' },
              ]}
            />
          )}
          {entry.provider === 'mock' && (
            <>
              <SelectField
                label="How should the simulated courier behave?"
                value={v.outcome ?? 'success'}
                onChange={(val) => form.set('outcome', val)}
                options={MOCK_OUTCOME_OPTIONS}
                hint="Rehearse what happens when a courier misbehaves."
              />
              <SelectField
                label="Can it find a booking again by our reference?"
                value={v.referenceLookup ?? 'no'}
                onChange={(val) => form.set('referenceLookup', val)}
                options={[
                  { value: 'no', label: 'No (like Pathao)' },
                  { value: 'yes', label: 'Yes (like Steadfast)' },
                ]}
              />
            </>
          )}

          {caps.webhooks && (
            <Stack gap={2}>
              <TextField
                label={
                  entry.provider === 'steadfast'
                    ? 'Webhook token you chose in Steadfast'
                    : 'Webhook secret you chose in Pathao'
                }
                kind="password"
                hint={
                  c?.hasWebhookSecret
                    ? 'Saved. Leave empty to keep it. At least 16 characters.'
                    : 'Choose a long random value (at least 16 characters), save it here, and enter the same value in the courier’s panel.'
                }
                autoComplete="off"
                {...form.field('webhookSecret')}
              />
              {c?.webhookUrl && (
                <Stack gap={1}>
                  <Text weight="medium">Webhook address to give the courier</Text>
                  <Text selectable>{c.webhookUrl}</Text>
                  {c.webhookUrl.startsWith('http://') && (
                    <Text variant="caption" tone="muted">
                      Couriers need a public https address. This one only works on your own
                      computer.
                    </Text>
                  )}
                </Stack>
              )}
            </Stack>
          )}

          <Row gap={2} wrap>
            <Button loading={busy === 'save'} onPress={save}>
              {entry.simulated && !connected ? 'Turn on' : `Save ${entry.name}`}
            </Button>
            {connected && (
              <Button variant="secondary" loading={busy === 'test'} onPress={test}>
                {`Test ${entry.name}`}
              </Button>
            )}
            {c && (c.hasCredentials || (entry.simulated && c.enabled)) && (
              <Button
                variant="danger"
                loading={busy === 'remove'}
                onPress={() => setConfirmRemove(true)}
              >
                {entry.simulated ? 'Turn off' : `Disconnect ${entry.name}`}
              </Button>
            )}
          </Row>
        </Stack>
      )}
      <ConfirmDialog
        open={confirmRemove}
        title={entry.simulated ? 'Turn off the simulated courier?' : `Disconnect ${entry.name}?`}
        confirmLabel={entry.simulated ? 'Turn off' : 'Disconnect'}
        danger
        onConfirm={async () => {
          setConfirmRemove(false);
          await remove();
        }}
        onClose={() => setConfirmRemove(false)}
      >
        <Text>
          {entry.simulated
            ? 'You will not be able to book new simulated parcels. Existing ones stay.'
            : 'The saved credentials are erased from the server. Existing shipments stay, but new bookings and live updates stop until you connect again.'}
        </Text>
      </ConfirmDialog>
    </Stack>
  );
}
