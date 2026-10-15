import { hash, verify } from '@node-rs/argon2';
import { Injectable } from '@nestjs/common';

// OWASP Password Storage Cheat Sheet, argon2id minimum: m=19 MiB, t=2, p=1.
// `algorithm: 2` is Argon2id (the library's const enum cannot be imported under isolatedModules).
const OPTIONS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class PasswordService {
  /** A real hash of a random value, verified against when the account does not exist so timing does not reveal it. */
  private readonly dummyHash: Promise<string> = hash(`dummy-${Math.random()}`, OPTIONS);

  hash(password: string): Promise<string> {
    return hash(password, OPTIONS);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  /** Burn the same CPU as a real verification. Always resolves to false. */
  async verifyDummy(password: string): Promise<false> {
    await this.verify(await this.dummyHash, password);
    return false;
  }
}
