import { ApiError } from '@orderloop/api-client';
import {
  AUTOMATION_KINDS,
  DEFAULT_RULE_CONFIG,
  DEFAULT_RULE_CHANNELS,
  type AutomationKind,
  type AutomationRule,
  type Delivery,
  type Run,
} from '@orderloop/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mount } from '../../../test/mount';
import { AutomationSettingsScreen } from './AutomationSettingsScreen';

const uuid = (n: number) => `0197b0a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const NOW = '2026-10-26T10:00:00.000Z';
const PERMISSION = {
  LOW_STOCK: 'inventory:read',
  NEW_ORDER: 'orders:read',
  UNCONFIRMED_ORDER: 'orders:read',
  DELAYED_ORDER: 'orders:read',
  COD_DISCREPANCY: 'finance:read',
  DAILY_REPORT: 'finance:read',
  WEEKLY_REPORT: 'finance:read',
} as const;

const run = (over: Partial<Run> = {}): Run => ({
  id: uuid(100),
  ruleId: uuid(1),
  kind: 'LOW_STOCK',
  slotKey: 'manual:k',
  trigger: 'manual',
  scheduledFor: NOW,
  status: 'succeeded',
  attempts: 1,
  error: null,
  createdCount: 1,
  skippedCount: 0,
  startedAt: NOW,
  finishedAt: NOW,
  createdAt: NOW,
  ...over,
});

/** Seven rules, none saved yet (defaults, off), unless a test says otherwise. */
const rules = (over: Partial<Record<AutomationKind, Partial<AutomationRule>>> = {}) =>
  AUTOMATION_KINDS.map((kind): AutomationRule => ({
    kind,
    configured: false,
    enabled: false,
    config: { ...DEFAULT_RULE_CONFIG[kind] },
    channels: { ...DEFAULT_RULE_CHANNELS },
    recipientPermission: PERMISSION[kind],
    updatedAt: null,
    lastRun: null,
    ...over[kind],
  }));
const providers = { push: 'expo', sms: false, whatsapp: false, email: true } as const;

function automationApi(
  over: {
    rules?: AutomationRule[];
    providers?: Record<string, unknown>;
    failedRuns?: Run[];
    failedDeliveries?: Delivery[];
  } = {},
) {
  let current = over.rules ?? rules();
  return {
    automation: {
      rules: vi.fn(async () => ({ rules: current, providers: over.providers ?? providers })),
      updateRule: vi.fn(
        async (
          kind: AutomationKind,
          body: { enabled?: boolean; config?: Record<string, unknown>; channels?: object },
        ) => {
          const saved: AutomationRule = {
            ...current.find((r) => r.kind === kind)!,
            configured: true,
            enabled: body.enabled ?? false,
            config: body.config ?? {},
            channels: { ...DEFAULT_RULE_CHANNELS, ...body.channels },
            updatedAt: NOW,
          };
          current = current.map((r) => (r.kind === kind ? saved : r));
          return saved;
        },
      ),
      runRule: vi.fn<(kind: AutomationKind, key?: string) => Promise<Run>>(async (kind) =>
        run({ kind }),
      ),
      runs: vi.fn(async () => ({ items: over.failedRuns ?? [], nextCursor: null })),
      deliveries: vi.fn(async () => ({ items: over.failedDeliveries ?? [], nextCursor: null })),
      retryRun: vi.fn(async () => run({ status: 'queued' })),
      retryDelivery: vi.fn(async () => ({}) as Delivery),
    },
  };
}

const card = async (name: string) => within(await screen.findByRole('group', { name }));
const switchOf = (c: ReturnType<typeof within>, name: string) => c.getByRole('switch', { name });

describe('the automation settings', () => {
  it('lists the seven kinds in plain words, each with its own switch and settings', async () => {
    mount(<AutomationSettingsScreen />, automationApi());
    expect(await screen.findByRole('heading', { level: 1, name: 'Automation' })).toBeTruthy();
    for (const name of [
      'Low stock',
      'New orders',
      'Orders waiting for confirmation',
      'Orders running late',
      'Cash on delivery differences',
      'Daily report',
      'Weekly report',
    ])
      expect(await screen.findByRole('group', { name })).toBeTruthy();
    const low = await card('Low stock');
    expect(low.getByText(/running low or has run out/)).toBeTruthy();
    expect(switchOf(low, 'Switched on')).toHaveAttribute('aria-checked', 'false');
    expect(low.getByText('Not set up yet')).toBeTruthy();
    expect(low.getByLabelText('Alert when stock is at or below')).toBeTruthy();
  });

  it('shows the report time with the business time zone, and the weekday', async () => {
    mount(<AutomationSettingsScreen />, automationApi());
    const weekly = await card('Weekly report');
    expect(weekly.getByLabelText('Send at')).toHaveValue('09:00');
    expect(weekly.getByLabelText('Send on')).toHaveValue('0');
    expect(weekly.getByText(/Times are in your business time zone: Asia\/Dhaka\./)).toBeTruthy();
    const orders = await card('New orders');
    expect(orders.queryByText(/business time zone/)).toBeNull();
  });

  it('shows SMS and WhatsApp only when the server can send them', async () => {
    const view = mount(<AutomationSettingsScreen />, automationApi());
    const low = await card('Low stock');
    expect(switchOf(low, 'Push to phones')).toBeTruthy();
    expect(switchOf(low, 'Email')).toBeTruthy();
    expect(low.queryByRole('switch', { name: 'SMS' })).toBeNull();
    expect(low.queryByRole('switch', { name: 'WhatsApp' })).toBeNull();
    view.unmount();

    mount(
      <AutomationSettingsScreen />,
      automationApi({ providers: { ...providers, sms: true, whatsapp: true } }),
    );
    const again = await card('Low stock');
    expect(switchOf(again, 'SMS')).toBeTruthy();
    expect(switchOf(again, 'WhatsApp')).toBeTruthy();
  });

  it('warns that push is in test mode on a server that only records it', async () => {
    mount(
      <AutomationSettingsScreen />,
      automationApi({ providers: { ...providers, push: 'dev' } }),
    );
    expect(await screen.findByText('Push is in test mode on this server')).toBeTruthy();
  });

  it('saves the switch, the limits and the channels of one rule', async () => {
    const api = automationApi();
    mount(<AutomationSettingsScreen />, api);
    const c = await card('Orders waiting for confirmation');
    const save = c.getByRole('button', { name: 'Save changes' });
    expect(save).toHaveAttribute('aria-disabled', 'true'); // nothing changed yet
    await userEvent.click(switchOf(c, 'Switched on'));
    const after = c.getByLabelText('First reminder after (minutes)');
    await userEvent.clear(after);
    await userEvent.type(after, '90');
    await userEvent.type(c.getByLabelText('Remind again every (minutes, optional)'), '30');
    await userEvent.click(switchOf(c, 'Email'));
    await userEvent.click(c.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(api.automation.updateRule).toHaveBeenCalledWith('UNCONFIRMED_ORDER', {
        enabled: true,
        config: { afterMinutes: 90, repeatEveryMinutes: 30 },
        channels: { inApp: true, push: true, email: true, sms: false, whatsapp: false },
      }),
    );
    // What was saved is what the card now shows: switched on, saved, nothing left to save.
    expect(await c.findByText('On')).toBeTruthy();
    await waitFor(() =>
      expect(c.getByRole('button', { name: 'Save changes' })).toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
  });

  it('refuses a number outside the limits, in words, without asking the server', async () => {
    const api = automationApi();
    mount(<AutomationSettingsScreen />, api);
    const c = await card('Orders running late');
    const field = c.getByLabelText('Running late after (hours)');
    await userEvent.clear(field);
    await userEvent.type(field, '1000');
    await userEvent.click(c.getByRole('button', { name: 'Save changes' }));
    expect(await c.findByText('Enter a whole number from 1 to 720.')).toBeTruthy();
    expect(api.automation.updateRule).not.toHaveBeenCalled();
    await userEvent.clear(field);
    await userEvent.type(field, '72');
    await userEvent.click(c.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.automation.updateRule).toHaveBeenCalledTimes(1));
  });

  it('asks for the number of units only when stock is judged against one number', async () => {
    const api = automationApi();
    mount(<AutomationSettingsScreen />, api);
    const c = await card('Low stock');
    expect(c.queryByLabelText('Number of units')).toBeNull();
    await userEvent.selectOptions(c.getByLabelText('Alert when stock is at or below'), 'fixed');
    await userEvent.click(c.getByRole('button', { name: 'Save changes' }));
    expect(await c.findByText('Enter a whole number from 0 to 1000000.')).toBeTruthy();
    await userEvent.type(c.getByLabelText('Number of units'), '4');
    await userEvent.click(switchOf(c, 'Also alert for products that are completely out of stock'));
    await userEvent.click(c.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(api.automation.updateRule).toHaveBeenCalledWith(
        'LOW_STOCK',
        expect.objectContaining({
          config: { basis: 'fixed', fixedQuantity: 4, includeZeroStock: false },
        }),
      ),
    );
  });

  it.each([
    ['channel_not_configured', /cannot send that kind of message yet/],
    ['consent_required', /Nobody who would get this alert has agreed/],
  ])('explains a %s refusal clearly and keeps what was typed', async (code, message) => {
    const api = automationApi({ providers: { ...providers, sms: true } });
    api.automation.updateRule.mockRejectedValueOnce(new ApiError('raw server text', 422, code));
    mount(<AutomationSettingsScreen />, api);
    const c = await card('Low stock');
    await userEvent.click(switchOf(c, 'SMS'));
    await userEvent.click(c.getByRole('button', { name: 'Save changes' }));
    expect(await c.findByText(message)).toBeTruthy();
    expect(c.queryByText('raw server text')).toBeNull();
    expect(switchOf(c, 'SMS')).toHaveAttribute('aria-checked', 'true');
  });

  describe('run now', () => {
    const saved = (over: Partial<AutomationRule> = {}) =>
      rules({ LOW_STOCK: { configured: true, enabled: true, updatedAt: NOW, ...over } });

    it('is not offered until the rule is saved and switched on', async () => {
      mount(<AutomationSettingsScreen />, automationApi());
      const c = await card('Low stock');
      expect(c.getByRole('button', { name: 'Run now' })).toHaveAttribute('aria-disabled', 'true');
      expect(c.getByText('Save and switch this rule on to run it now.')).toBeTruthy();
    });

    it('runs the rule and says how many notifications it made and how many it skipped', async () => {
      const api = automationApi({ rules: saved() });
      api.automation.runRule.mockResolvedValueOnce(run({ createdCount: 3, skippedCount: 2 }));
      mount(<AutomationSettingsScreen />, api);
      const c = await card('Low stock');
      await userEvent.click(c.getByRole('button', { name: 'Run now' }));
      expect(await c.findByText('Run finished')).toBeTruthy();
      expect(
        c.getByText('New notifications: 3. Skipped (already told or not needed): 2.'),
      ).toBeTruthy();
      expect(api.automation.runRule).toHaveBeenCalledWith(
        'LOW_STOCK',
        expect.stringMatching(/^app-/),
      );
    });

    it('uses the same key to retry after a failure and a new one after a success', async () => {
      const api = automationApi({ rules: saved() });
      api.automation.runRule
        .mockRejectedValueOnce(new ApiError('slow', undefined, 'request_timeout'))
        .mockResolvedValue(run({ createdCount: 0, skippedCount: 4 }));
      mount(<AutomationSettingsScreen />, api);
      const c = await card('Low stock');
      await userEvent.click(c.getByRole('button', { name: 'Run now' }));
      await userEvent.click(await c.findByRole('button', { name: 'Run now' }));
      expect(await c.findByText('Run finished')).toBeTruthy();
      await userEvent.click(c.getByRole('button', { name: 'Run now' }));
      await waitFor(() => expect(api.automation.runRule).toHaveBeenCalledTimes(3));
      const keys = api.automation.runRule.mock.calls.map((call) => call[1]);
      expect(keys[1]).toBe(keys[0]);
      expect(keys[2]).not.toBe(keys[1]);
    });

    it('says when a run found nobody to tell, and when it failed', async () => {
      const api = automationApi({ rules: saved() });
      api.automation.runRule
        .mockResolvedValueOnce(run({ status: 'skipped', createdCount: 0 }))
        .mockResolvedValueOnce(run({ status: 'failed', error: 'database unavailable' }));
      mount(<AutomationSettingsScreen />, api);
      const c = await card('Low stock');
      await userEvent.click(c.getByRole('button', { name: 'Run now' }));
      expect(await c.findByText(/nobody is set to receive this alert/)).toBeTruthy();
      await userEvent.click(c.getByRole('button', { name: 'Run now' }));
      expect(await c.findByText('The run failed')).toBeTruthy();
      expect(c.getByText('database unavailable')).toBeTruthy();
    });

    it('shows a refusal (too many runs) as a message', async () => {
      const api = automationApi({ rules: saved() });
      api.automation.runRule.mockRejectedValueOnce(
        new ApiError('Too many manual runs. Wait a minute.', 429, 'rate_limited'),
      );
      mount(<AutomationSettingsScreen />, api);
      await userEvent.click((await card('Low stock')).getByRole('button', { name: 'Run now' }));
      expect(await screen.findByText('Too many manual runs. Wait a minute.')).toBeTruthy();
    });

    it('says what the last run did', async () => {
      const api = automationApi({
        rules: saved({ lastRun: run({ createdCount: 2, skippedCount: 1 }) }),
      });
      mount(<AutomationSettingsScreen />, api);
      const c = await card('Low stock');
      expect(c.getByText('Last run: Done')).toBeTruthy();
      expect(c.getByText('New: 2, skipped: 1')).toBeTruthy();
    });
  });

  describe('recent runs and problems', () => {
    const failedRun = run({
      id: uuid(200),
      kind: 'DELAYED_ORDER',
      status: 'failed',
      attempts: 3,
      error: 'transient:database timeout',
    });
    const failedDelivery: Delivery = {
      id: uuid(300),
      notificationId: uuid(1),
      kind: 'LOW_STOCK',
      recipientUserId: uuid(2),
      channel: 'email',
      status: 'failed',
      attempts: 5,
      lastError: 'permanent:mailbox does not exist',
      sentAt: null,
      createdAt: NOW,
    };

    it('lists what failed with the reason in words, and retries on request', async () => {
      const api = automationApi({ failedRuns: [failedRun], failedDeliveries: [failedDelivery] });
      mount(<AutomationSettingsScreen />, api);
      expect(await screen.findByRole('heading', { name: 'Recent runs and problems' })).toBeTruthy();
      expect(await screen.findByText('Orders running late: the check did not finish')).toBeTruthy();
      expect(screen.getByText(/A temporary problem:/)).toBeTruthy();
      expect(screen.getByText('database timeout')).toBeTruthy();
      expect(screen.getByText('Low stock: Email not delivered')).toBeTruthy();
      expect(screen.getByText(/It cannot be delivered:/)).toBeTruthy();
      expect(screen.getByText('mailbox does not exist')).toBeTruthy();
      expect(api.automation.runs).toHaveBeenCalledWith({ status: 'failed', limit: 25 });
      expect(api.automation.deliveries).toHaveBeenCalledWith({ status: 'failed', limit: 25 });

      const retries = screen.getAllByRole('button', { name: 'Retry' });
      expect(retries).toHaveLength(2);
      await userEvent.click(retries[0]!);
      await waitFor(() => expect(api.automation.retryRun).toHaveBeenCalledWith(uuid(200)));
      await userEvent.click(screen.getAllByRole('button', { name: 'Retry' })[1]!);
      await waitFor(() => expect(api.automation.retryDelivery).toHaveBeenCalledWith(uuid(300)));
    });

    it('says everything is fine when nothing failed', async () => {
      mount(<AutomationSettingsScreen />, automationApi());
      expect(await screen.findByText(/Nothing has failed recently/)).toBeTruthy();
    });

    it('shows a retry that the server refused', async () => {
      const api = automationApi({ failedRuns: [failedRun] });
      api.automation.retryRun.mockRejectedValueOnce(new ApiError('x', undefined, 'network_error'));
      mount(<AutomationSettingsScreen />, api);
      await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
      expect(await screen.findByText(/Cannot reach the server/)).toBeTruthy();
    });
  });

  describe('who may do what', () => {
    it('lets a manager look but not change: no save, no run, no retry, fields locked', async () => {
      const api = automationApi({
        rules: rules({ LOW_STOCK: { configured: true, enabled: true } }),
        failedRuns: [run({ status: 'failed', error: 'permanent:bad' })],
      });
      mount(<AutomationSettingsScreen />, api, 'MANAGER');
      expect(await screen.findByText(/Only an owner or admin can change automation/)).toBeTruthy();
      const c = await card('Low stock');
      expect(switchOf(c, 'Switched on')).toHaveAttribute('aria-disabled', 'true');
      expect(c.queryByRole('button', { name: 'Save changes' })).toBeNull();
      expect(c.queryByRole('button', { name: 'Run now' })).toBeNull();
      await screen.findByText(/It cannot be delivered/);
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    });

    it.each(['ACCOUNTANT', 'STAFF'] as const)(
      'shows %s that they have no access, and asks the server for nothing',
      async (role) => {
        const api = automationApi();
        mount(<AutomationSettingsScreen />, api, role);
        expect(await screen.findByText('You do not have access to automation')).toBeTruthy();
        expect(screen.queryByRole('group', { name: 'Low stock' })).toBeNull();
        expect(api.automation.rules).not.toHaveBeenCalled();
      },
    );
  });

  it('says so when the rules cannot be loaded, and tries again', async () => {
    const api = automationApi();
    // A refusal (not a lost connection) is not retried by itself, so the message shows at once.
    api.automation.rules.mockRejectedValueOnce(new ApiError('Not available', 404, 'not_found'));
    mount(<AutomationSettingsScreen />, api);
    expect(await screen.findByText('Not available')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('group', { name: 'Low stock' })).toBeTruthy();
  });
});
