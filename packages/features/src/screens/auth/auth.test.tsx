import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '../../../test/mount';
import { LoginScreen } from './LoginScreen';
import { ResetPasswordScreen } from './ResetPasswordScreen';
import { SignupScreen } from './SignupScreen';
import { WorkspaceSettingsScreen } from '../workspace/WorkspaceSettingsScreen';

describe('sign-in and sign-up screens', () => {
  it('sign-in has one h1, the labelled fields, a show/hide button and the secondary links', async () => {
    mount(<LoginScreen />, {});
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeTruthy();
    expect(screen.getByLabelText(/^Email/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Forgot your password?' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Create an account' })).toBeTruthy();

    const password = screen.getByLabelText(/^Password/) as HTMLInputElement;
    expect(password.type).toBe('password');
    await userEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(password.type).toBe('text');
    await userEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(password.type).toBe('password');
  });

  it('sign-in names what is missing without revealing the password rule', async () => {
    mount(<LoginScreen />, {});
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Email is required')).toBeTruthy();
    expect(screen.getByText('Password is required')).toBeTruthy();
  });

  it('sign-up asks for name, business, email and password', () => {
    mount(<SignupScreen />, {});
    expect(screen.getByRole('heading', { level: 1, name: 'Create your account' })).toBeTruthy();
    for (const label of ['Your name', 'Business name', 'Email', 'Password'])
      expect(screen.getByLabelText(new RegExp(`^${label}`))).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeTruthy();
  });

  it('an incomplete reset link says so and offers a new one', () => {
    mount(<ResetPasswordScreen />, {});
    expect(screen.getByText(/This reset link is incomplete/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Request a new link' })).toBeTruthy();
  });
});

describe('settings', () => {
  const api = {
    workspaces: { list: async () => [] },
    getTenant: async () => ({}),
  };
  it('has a Settings heading and the three sections as tabs', async () => {
    mount(<WorkspaceSettingsScreen />, api);
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    await screen.findByRole('tab', { name: 'Couriers' }); // the role is known once the session loads
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Business profile', 'Preferences', 'Couriers']);
    await userEvent.click(screen.getByRole('tab', { name: 'Couriers' }));
    expect(screen.getByRole('link', { name: 'Manage couriers' })).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Preferences' }));
    expect(await screen.findByLabelText('Your language')).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Colour theme' })).toBeTruthy();
  });
});

describe('settings: the business changes on the server while the form is open', () => {
  afterEach(() => vi.useRealTimers());

  /** Come back to the tab after a while: stale data is refetched on focus. */
  async function comeBack(tenant: ReturnType<typeof vi.fn>) {
    const calls = tenant.mock.calls.length;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_000);
    act(() => void window.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(tenant.mock.calls.length).toBeGreaterThan(calls));
  }
  const open = (name: { value: string }) => {
    const tenant = vi.fn(async () => ({
      id: 't',
      name: name.value,
      logoUrl: null,
      currency: 'BDT',
      timezone: 'Asia/Dhaka',
      defaultLanguage: 'en',
      country: 'BD',
    }));
    mount(<WorkspaceSettingsScreen />, { tenant, workspaces: { list: async () => [] } });
    return tenant;
  };

  it('does not wipe what is being typed', async () => {
    const name = { value: 'Shop' };
    const tenant = open(name);
    const field = (await screen.findByDisplayValue('Shop')) as HTMLInputElement;
    await userEvent.type(field, ' Extra');
    name.value = 'Renamed elsewhere';
    await comeBack(tenant);
    await act(async () => undefined);
    expect(field.value).toBe('Shop Extra');
  });

  it('shows the new value when nothing has been typed', async () => {
    const name = { value: 'Shop' };
    const tenant = open(name);
    await screen.findByDisplayValue('Shop');
    name.value = 'Renamed elsewhere';
    await comeBack(tenant);
    expect(await screen.findByDisplayValue('Renamed elsewhere')).toBeTruthy();
  });
});
