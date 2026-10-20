import type { AuthResult } from '@orderloop/contracts';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { AppProviders } from '../src/components/AppProviders';
import type { Runtime } from '../src/runtime';
import { SessionManager } from '../src/session';

export const session = (role: AuthResult['role'] = 'OWNER'): AuthResult => ({
  accessToken: 'token',
  expiresIn: 900,
  user: { id: 'u', email: 'a@b.test', name: 'Anwar', emailVerified: true, language: 'en' },
  tenant: {
    id: 't',
    name: 'Shop',
    logoUrl: null,
    currency: 'BDT',
    timezone: 'Asia/Dhaka',
    defaultLanguage: 'en',
  },
  role,
  memberships: [],
});

/** A screen mounted the way both apps mount it, over a fake API that records what the screen sends. */
export function mount(
  ui: React.ReactElement,
  api: Record<string, unknown>,
  role: AuthResult['role'] = 'OWNER',
) {
  const manager = new SessionManager({
    refresh: async () => session(role),
    logout: async () => undefined,
  });
  const runtime = { api, session: manager, home: '/products' } as unknown as Runtime;
  const navigation = { pathname: '/orders', push: vi.fn(), replace: vi.fn(), back: vi.fn() };
  const view = render(
    <AppProviders
      runtime={runtime}
      navigation={navigation}
      {...(process.env.TEST_LOCALE === 'bn' ? { language: { initial: 'bn' as const } } : {})}
    >
      {ui}
    </AppProviders>,
  );
  return { ...view, navigation };
}
