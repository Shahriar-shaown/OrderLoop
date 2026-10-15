import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

describe('HealthController', () => {
  it('live returns ok', async () => {
    const mod = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: HealthService, useValue: {} }],
    }).compile();
    expect(mod.get(HealthController).live()).toEqual({ status: 'ok' });
  });

  it('ready sets 503 when a dependency is down', async () => {
    const degraded = { status: 'degraded', checks: { postgres: 'up', redis: 'down' } };
    const mod = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: HealthService, useValue: { check: async () => degraded } }],
    }).compile();
    const statuses: number[] = [];
    const res = { status: (c: number) => statuses.push(c) } as never;
    expect(await mod.get(HealthController).ready(res)).toEqual(degraded);
    expect(statuses).toEqual([503]);
  });
});
