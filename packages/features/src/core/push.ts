import type { ApiClient } from '@orderloop/api-client';

export type PushPermission = 'granted' | 'denied' | 'undetermined';

/** This phone, as the push service knows it. */
export interface PushToken {
  token: string;
  platform: 'ios' | 'android';
}

/** What a push carries: the kind and the id of the notification it announces (never any business data). */
export interface PushMessage {
  kind: string;
  id: string;
}

/**
 * What the phone provides for push notifications. The mobile app implements it with the system's notification service;
 * the web app passes nothing, so on the web every call below is a no-op. Nothing here prompts except `requestPermission`.
 */
export interface PushPlatform {
  /** False where push cannot work (a simulator, a build with no project id): the app then offers nothing and asks nothing. */
  readonly supported: boolean;
  permission(): Promise<PushPermission>;
  /** Show the system's "allow notifications?" question (where the system has one) and say what was answered. */
  requestPermission(): Promise<PushPermission>;
  /** This phone's token, or null when it has none (a simulator, no project id in the build, not allowed). Never prompts. */
  token(): Promise<PushToken | null>;
  /** Called when the push service issues a new token. Returns the function that stops listening. */
  onTokenChange(listener: (token: PushToken) => void): () => void;
  /** A push arrived while the app is open. */
  onReceived(listener: (message: PushMessage) => void): () => void;
  /** A push was tapped, including the one that launched the app (replayed to the first listener). */
  onOpened(listener: (message: PushMessage) => void): () => void;
}

/** Signing out must never wait long for the server to forget a phone. */
const FORGET_TIMEOUT_MS = 3000;

/**
 * Tells the server which phone to push to, and to stop when the person signs out. Everything is best effort: a failure here
 * (offline, server busy) never blocks the person, and the next `sync` tries again.
 */
export class PushRegistrar {
  private registered: string | null = null;

  constructor(
    readonly platform: PushPlatform,
    private readonly api: Pick<ApiClient, 'pushDevices'>,
    private readonly warn: (message: string) => void = () => undefined,
  ) {}

  /** Register this phone if the person has already allowed notifications. Returns the registered token, or null. */
  async sync(): Promise<string | null> {
    try {
      if (!this.platform.supported || (await this.platform.permission()) !== 'granted') return null;
      const device = await this.platform.token();
      if (!device) return null;
      if (device.token !== this.registered) {
        await this.api.pushDevices.register({ token: device.token, platform: device.platform });
        this.registered = device.token;
      }
      return device.token;
    } catch (error) {
      this.warn(`Could not register this phone for push: ${String(error)}`);
      return null;
    }
  }

  /** Ask the person (the system prompt) and, if they agree, register this phone. */
  async enable(): Promise<PushPermission> {
    const answer = await this.platform.requestPermission();
    if (answer === 'granted') await this.sync();
    return answer;
  }

  /** Make the server forget this phone (before signing out). Waits at most a few seconds and never throws. */
  async unregister(): Promise<void> {
    try {
      const token = this.registered ?? (await this.currentToken());
      if (!token) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tooLong = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), FORGET_TIMEOUT_MS);
      });
      try {
        await Promise.race([this.api.pushDevices.remove(token), tooLong]);
      } finally {
        clearTimeout(timer);
      }
      this.registered = null;
    } catch (error) {
      this.warn(`Could not remove this phone from push: ${String(error)}`);
    }
  }

  private async currentToken(): Promise<string | null> {
    if (!this.platform.supported) return null;
    if ((await this.platform.permission()) !== 'granted') return null;
    return (await this.platform.token())?.token ?? null;
  }
}
