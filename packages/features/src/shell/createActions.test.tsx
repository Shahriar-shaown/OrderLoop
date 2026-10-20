import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { session } from '../../test/mount';
import { AuthProvider } from '../core/auth';
import type { Runtime } from '../core/runtime';
import { RuntimeProvider } from '../core/runtime';
import { SessionManager } from '../core/session';
import { useCreateActions } from './createActions';

async function actionsFor(role: Parameters<typeof session>[0]) {
  const manager = new SessionManager({ refresh: async () => session(role), logout: vi.fn() });
  await manager.init();
  const runtime = { api: {}, session: manager, home: '/' } as unknown as Runtime;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RuntimeProvider runtime={runtime}>
      <AuthProvider>{children}</AuthProvider>
    </RuntimeProvider>
  );
  return renderHook(() => useCreateActions().map((a) => a.label), { wrapper }).result.current;
}

describe('the create menu', () => {
  it('is one list for every app: an order, a product and a customer for someone who can write both', async () => {
    expect(await actionsFor('OWNER')).toEqual(['New order', 'New product', 'New customer']);
  });

  it('is empty for a role that can create nothing, so the control can be hidden', async () => {
    expect(await actionsFor('ACCOUNTANT')).toEqual([]);
  });
});
