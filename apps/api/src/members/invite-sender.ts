import { Injectable, Logger } from '@nestjs/common';
import type { Role } from '@orderloop/contracts';

export interface InviteMessage {
  email: string;
  role: Role;
  tenantId: string;
  token: string;
  link: string;
}

/** Delivery channel for invitations. An email provider is a Phase-10 integration; until then this is the seam. */
export abstract class InviteSender {
  abstract send(message: InviteMessage): Promise<void>;
}

/** Development only: prints the invitation link instead of emailing it. */
@Injectable()
export class ConsoleInviteSender extends InviteSender {
  private readonly logger = new Logger('InviteSender');
  async send(message: InviteMessage): Promise<void> {
    this.logger.log(`[dev] invitation for ${message.email} (${message.role}): ${message.link}`);
  }
}

/** Production default until an email provider is configured: fail loudly rather than drop invitations. */
@Injectable()
export class UnconfiguredInviteSender extends InviteSender {
  async send(): Promise<void> {
    throw new Error('No email provider is configured; invitations cannot be delivered');
  }
}

/** Test double that records what would have been sent. */
@Injectable()
export class MemoryInviteSender extends InviteSender {
  readonly sent: InviteMessage[] = [];
  async send(message: InviteMessage): Promise<void> {
    this.sent.push(message);
  }
}
