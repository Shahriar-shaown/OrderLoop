import { describe, expect, it, vi } from 'vitest';
import { registerTenantPurge, runTenantPurge } from './tenant-purge.js';

const result = (over = {}) => ({
  purged: true,
  rowsDeleted: 12,
  counts: { orders: 3 },
  userAnonymised: false,
  ...over,
});

describe('runTenantPurge', () => {
  it('purges every business that is due and logs counts, ids only', async () => {
    const log = vi.fn();
    const db = {
      tenantsDueForPurge: vi.fn().mockResolvedValue(['t1', 't2']),
      purgeTenant: vi.fn().mockResolvedValue(result()),
    };
    expect(await runTenantPurge({ db, log })).toEqual({ purged: 2, skipped: 0, failed: 0 });
    expect(db.purgeTenant).toHaveBeenCalledWith('t1');
    expect(db.purgeTenant).toHaveBeenCalledWith('t2');
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'tenant.purged', tenantId: 't1', rows: 12 }),
    );
    for (const [event] of log.mock.calls) expect(Object.keys(event)).not.toContain('name');
  });

  it('counts a business the database refused (cancelled meanwhile, or taken by another worker) as skipped, not as an error', async () => {
    const db = {
      tenantsDueForPurge: vi.fn().mockResolvedValue(['t1']),
      purgeTenant: vi.fn().mockResolvedValue(result({ purged: false, rowsDeleted: 0 })),
    };
    expect(await runTenantPurge({ db, log: vi.fn() })).toEqual({
      purged: 0,
      skipped: 1,
      failed: 0,
    });
  });

  it('one failing business does not stop the others', async () => {
    const log = vi.fn();
    const db = {
      tenantsDueForPurge: vi.fn().mockResolvedValue(['bad', 'good']),
      purgeTenant: vi
        .fn()
        .mockRejectedValueOnce(new Error('boom with a secret'))
        .mockResolvedValueOnce(result()),
    };
    expect(await runTenantPurge({ db, log })).toEqual({ purged: 1, skipped: 0, failed: 1 });
    const failed = log.mock.calls.find(([e]) => e.event === 'tenant.purge_failed')![0];
    expect(JSON.stringify(failed)).not.toContain('secret'); // the error's name, never its message
  });

  it('does nothing when nothing is due', async () => {
    const db = { tenantsDueForPurge: vi.fn().mockResolvedValue([]), purgeTenant: vi.fn() };
    expect(await runTenantPurge({ db, log: vi.fn() })).toEqual({
      purged: 0,
      skipped: 0,
      failed: 0,
    });
    expect(db.purgeTenant).not.toHaveBeenCalled();
  });
});

describe('registerTenantPurge', () => {
  it('registers one hourly scheduler by a fixed id, so several workers still make one purge', async () => {
    const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    await registerTenantPurge({ upsertJobScheduler });
    await registerTenantPurge({ upsertJobScheduler });
    for (const call of upsertJobScheduler.mock.calls) {
      expect(call[0]).toBe('tenant-purge');
      expect(call[1]).toEqual({ every: 3_600_000 });
    }
  });
});
