import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { session as sampleSession } from '../../../test/mount';
import { AppProviders } from '../../shell/AppProviders';
import type { Runtime } from '../../core/runtime';
import { SessionManager } from '../../core/session';
import { HomeScreen } from './HomeScreen';
import { LoginScreen } from './LoginScreen';

function open(ui: React.ReactElement, manager: SessionManager) {
  const runtime = { api: {}, session: manager, home: '/dashboard' } as unknown as Runtime;
  const navigation = { pathname: '/', push: vi.fn(), replace: vi.fn(), back: vi.fn() };
  render(
    <AppProviders runtime={runtime} navigation={navigation}>
      {ui}
    </AppProviders>,
  );
  return navigation;
}

describe('opening the app without a connection', () => {
  it('says so and offers Try again, instead of a spinner that never ends; the saved session is kept', async () => {
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockResolvedValue(sampleSession());
    const manager = new SessionManager({ refresh, logout: async () => undefined });
    const navigation = open(<HomeScreen />, manager);

    expect(await screen.findByText('Cannot reach OrderLoop.')).toBeTruthy();
    expect(navigation.replace).not.toHaveBeenCalled(); // not sent to sign in: nothing is wrong with the session

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('/dashboard'));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('sends a refused session to sign in, which is a different thing', async () => {
    const refresh = vi.fn().mockRejectedValue(Object.assign(new Error('no'), { status: 401 }));
    const manager = new SessionManager({ refresh, logout: async () => undefined });
    const navigation = open(<HomeScreen />, manager);
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('/login'));
    expect(screen.queryByText('Cannot reach OrderLoop.')).toBeNull();
  });
});

describe('a session that expired while the app was open', () => {
  it('lands on sign-in with an explanation', async () => {
    const refresh = vi
      .fn()
      .mockResolvedValueOnce(sampleSession())
      .mockRejectedValueOnce(Object.assign(new Error('revoked'), { status: 401 }));
    const manager = new SessionManager({ refresh, logout: async () => undefined });
    await manager.init();
    await manager.refresh(); // the server no longer accepts the session
    open(<LoginScreen />, manager);
    expect(
      await screen.findByText('Your session has expired. Sign in again to continue.'),
    ).toBeTruthy();
    await act(async () => undefined);
  });

  it('does not mention expiry to someone who simply has not signed in', async () => {
    const refresh = vi.fn().mockRejectedValue(Object.assign(new Error('no'), { status: 401 }));
    const manager = new SessionManager({ refresh, logout: async () => undefined });
    await manager.init();
    open(<LoginScreen />, manager);
    await screen.findByRole('button', { name: 'Sign in' });
    expect(screen.queryByText(/session has expired/)).toBeNull();
  });
});

describe('the data cache and who is signed in', () => {
  it("is emptied when the session ends, so the next person never sees the last one's data", async () => {
    const manager = new SessionManager({
      refresh: vi.fn().mockResolvedValue(sampleSession()),
      logout: async () => undefined,
    });
    let client!: QueryClient;
    function Probe() {
      client = useQueryClient();
      return null;
    }
    open(<Probe />, manager);
    await manager.init();
    client.setQueryData(['orders'], ['secret order']);
    await manager.logout();
    expect(client.getQueryData(['orders'])).toBeUndefined();
  });
});
