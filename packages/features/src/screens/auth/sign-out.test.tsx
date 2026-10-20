import { ApiError } from '@orderloop/api-client';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { session as sampleSession } from '../../../test/mount';
import { useSignOut } from '../../core/auth';
import type { Runtime } from '../../core/runtime';
import { SessionManager, SIGN_OUT_FAILED, TENANT_CHANGED_MESSAGE } from '../../core/session';
import { AppProviders } from '../../shell/AppProviders';
import { LoginScreen } from './LoginScreen';

function open(ui: React.ReactElement, manager: SessionManager, api: object = {}) {
  const runtime = { api, session: manager, home: '/dashboard' } as unknown as Runtime;
  const navigation = { pathname: '/', push: vi.fn(), replace: vi.fn(), back: vi.fn() };
  render(
    <AppProviders runtime={runtime} navigation={navigation}>
      {ui}
    </AppProviders>,
  );
  return navigation;
}

const refused = () => Promise.reject(Object.assign(new Error('no'), { status: 401 }));

function SignOutButton() {
  const { signOut } = useSignOut();
  return <button onClick={() => void signOut()}>Sign out</button>;
}

describe('signing out', () => {
  it('while offline says so, keeps the person signed in and does not leave the screen', async () => {
    const logout = vi.fn(() =>
      Promise.reject(new ApiError('You are offline.', undefined, 'offline')),
    );
    const manager = new SessionManager({ refresh: async () => sampleSession(), logout });
    await manager.init();
    const navigation = open(<SignOutButton />, manager);
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText(SIGN_OUT_FAILED)).toBeTruthy();
    expect(manager.getSnapshot().status).toBe('authenticated');
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it('online clears the session and goes to sign-in', async () => {
    const manager = new SessionManager({
      refresh: async () => sampleSession(),
      logout: async () => undefined,
    });
    await manager.init();
    const navigation = open(<SignOutButton />, manager);
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('/login'));
    expect(manager.getSnapshot().status).toBe('anonymous');
  });
});

describe('sign-in', () => {
  it('moves on exactly once after signing in', async () => {
    const manager = new SessionManager({ refresh: refused, logout: async () => undefined });
    const api = { auth: { login: vi.fn(async () => sampleSession()) } };
    const navigation = open(<LoginScreen />, manager, api);
    await userEvent.type(await screen.findByLabelText(/^Email/), 'a@b.test');
    await userEvent.type(screen.getByLabelText(/^Password/), 'a-long-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('/dashboard'));
    await new Promise((r) => setTimeout(r, 50));
    expect(navigation.replace).toHaveBeenCalledTimes(1);
  });

  it('explains a session ended by a switch of business in another tab', async () => {
    const refresh = vi
      .fn()
      .mockResolvedValueOnce(sampleSession())
      .mockRejectedValueOnce(new ApiError('changed', 409, 'tenant_changed'));
    const manager = new SessionManager({ refresh, logout: async () => undefined });
    await manager.init();
    await manager.refresh();
    open(<LoginScreen />, manager);
    expect(await screen.findByText(TENANT_CHANGED_MESSAGE)).toBeTruthy();
  });
});
