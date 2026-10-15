import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { DependencyStatus, ReadyResponse } from '@orderloop/contracts';
import { loadServerEnv } from '@orderloop/contracts/server';
import { Redis } from 'ioredis';
import { Client } from 'pg';

const TIMEOUT_MS = 1500;

async function probe(fn: () => Promise<unknown>): Promise<DependencyStatus> {
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)),
    ]);
    return 'up';
  } catch {
    return 'down';
  }
}

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly env = loadServerEnv();

  async check(): Promise<ReadyResponse> {
    const [postgres, redis] = await Promise.all([this.pingPostgres(), this.pingRedis()]);
    return {
      status: postgres === 'up' && redis === 'up' ? 'ok' : 'degraded',
      checks: { postgres, redis },
    };
  }

  private pingPostgres(): Promise<DependencyStatus> {
    return probe(async () => {
      const client = new Client({
        connectionString: this.env.DATABASE_URL,
        connectionTimeoutMillis: TIMEOUT_MS,
      });
      client.on('error', () => undefined);
      try {
        await client.connect();
        await client.query('SELECT 1');
      } finally {
        await client.end().catch(() => undefined);
      }
    });
  }

  private pingRedis(): Promise<DependencyStatus> {
    return probe(async () => {
      const redis = new Redis(this.env.REDIS_URL, {
        lazyConnect: true,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
        connectTimeout: TIMEOUT_MS,
      });
      redis.on('error', () => undefined);
      try {
        await redis.connect();
        await redis.ping();
      } finally {
        redis.disconnect();
      }
    });
  }

  onModuleDestroy(): void {
    // Connections are per-probe; nothing to release.
  }
}
