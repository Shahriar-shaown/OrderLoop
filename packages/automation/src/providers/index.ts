import type { PushProviderName } from '@orderloop/contracts';
import type { Logger } from '../jobs.js';
import { ConsoleMessagingProvider } from './messaging.js';
import { DevPushProvider, ExpoPushProvider } from './push.js';
import type { DeliveryProviders, EmailSender } from './types.js';

export * from './types.js';
export { ConsoleMessagingProvider, maskPhone } from './messaging.js';
export { DevPushProvider, ExpoPushProvider, EXPO_BATCH, tokenFingerprint } from './push.js';

/** The environment settings that choose providers (a subset of the server env). */
export interface ProviderEnv {
  nodeEnv: 'development' | 'test' | 'production';
  pushProvider: PushProviderName;
  pushDevOutbox?: string | undefined;
  expoAccessToken?: string | undefined;
  smsProvider: 'none' | 'console';
  whatsappProvider: 'none' | 'console';
}

/** Which delivery channels this server can use: the API asks this to refuse a rule that could never send. */
export function channelAvailability(env: Pick<ProviderEnv, 'smsProvider' | 'whatsappProvider'>) {
  return { sms: env.smsProvider !== 'none', whatsapp: env.whatsappProvider !== 'none' };
}

export function buildProviders(
  env: ProviderEnv,
  email: EmailSender | null,
  log: Logger,
): DeliveryProviders {
  if (env.nodeEnv === 'production') {
    if (env.pushProvider === 'dev')
      log({
        level: 'warn',
        event: 'push.dev_provider_in_production',
        message:
          'PUSH_PROVIDER=dev in production: push notifications are logged, not delivered. Set PUSH_PROVIDER=expo.',
      });
    if (env.smsProvider === 'console' || env.whatsappProvider === 'console')
      log({
        level: 'warn',
        event: 'messaging.console_provider_in_production',
        message:
          'SMS_PROVIDER/WHATSAPP_PROVIDER=console in production: messages are logged, not delivered.',
      });
  }
  return {
    push: {
      [env.pushProvider]:
        env.pushProvider === 'expo'
          ? new ExpoPushProvider({ accessToken: env.expoAccessToken })
          : new DevPushProvider({ log, outboxPath: env.pushDevOutbox }),
    },
    email,
    sms: env.smsProvider === 'console' ? new ConsoleMessagingProvider({ log }) : null,
    whatsapp: env.whatsappProvider === 'console' ? new ConsoleMessagingProvider({ log }) : null,
  };
}
