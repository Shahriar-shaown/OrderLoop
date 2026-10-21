import type { PushMessage, PushPermission, PushPlatform, PushToken } from '@orderloop/features';

/**
 * What the phone's notification modules provide, in the plain terms the app needs. `push.ts` fills it from Expo's modules; a
 * test fills it with fakes. Keeping the rules here (what counts as allowed, which token, when to stay silent) in code that
 * does not import a native module is what lets them be tested.
 */
export interface PushSystem {
  os: string;
  /** A real phone (not a simulator or emulator). */
  isDevice: boolean;
  /** Expo Go cannot receive push; a development or store build can. */
  isExpoGo: boolean;
  /** The EAS project the push token belongs to (`extra.eas.projectId`); absent until the project is created. */
  projectId: string | undefined;
  getPermission(): Promise<{ status: PushPermission; canAskAgain: boolean }>;
  requestPermission(): Promise<{ status: PushPermission; canAskAgain: boolean }>;
  /** Android needs the notification channel before the first token or permission request. */
  ensureChannel(): Promise<void>;
  getExpoToken(projectId: string): Promise<string>;
  /** Show pushes that arrive in the foreground as an in-app toast instead of the system's banner. */
  quietForeground(): void;
  onDeviceTokenChange(listener: () => void): () => void;
  onReceived(listener: (data: unknown) => void): () => void;
  onTapped(listener: (data: unknown) => void): () => void;
  /** The push that opened the app from closed, if any, and forget it so it is not opened twice. */
  takeLaunchTap(): Promise<unknown>;
  /** Written once each: these are for whoever builds the app, not for the person using it. */
  log(message: string): void;
}

/** A push carries the kind and the notification's id; anything else is ignored. */
export function parseMessage(data: unknown): PushMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const { kind, id } = data as Record<string, unknown>;
  return typeof kind === 'string' && typeof id === 'string' && id ? { kind, id } : null;
}

/** The push seam of the mobile app: the shared `PushPlatform`, made from the phone's notification modules. */
export function createPushPlatform(system: PushSystem): PushPlatform {
  const platform = system.os === 'ios' || system.os === 'android' ? system.os : null;
  const reason = !platform
    ? 'this is not a phone'
    : system.isExpoGo
      ? 'Expo Go cannot receive push notifications (use a development build)'
      : !system.isDevice
        ? 'push needs a real phone, not a simulator'
        : !system.projectId
          ? 'there is no EAS project id in the app config (set EAS_PROJECT_ID)'
          : null;
  const supported = reason === null;
  const warned = new Set<string>();
  const logOnce = (message: string) => {
    if (warned.has(message)) return;
    warned.add(message);
    system.log(message);
  };
  const quiet = () => () => undefined;

  if (!supported) {
    logOnce(`Push notifications are off: ${reason}.`);
    return {
      supported: false,
      permission: async () => 'denied',
      requestPermission: async () => 'denied',
      token: async () => null,
      onTokenChange: quiet,
      onReceived: quiet,
      onOpened: quiet,
    };
  }
  system.quietForeground();

  // "Denied, but the system will still ask once more" is "not decided" for the person.
  const answer = (r: { status: PushPermission; canAskAgain: boolean }): PushPermission =>
    r.status === 'denied' && r.canAskAgain ? 'undetermined' : r.status;
  const token = async (): Promise<PushToken | null> => {
    try {
      await system.ensureChannel();
      return { token: await system.getExpoToken(system.projectId!), platform: platform! };
    } catch (error) {
      logOnce(`Could not get a push token: ${String(error)}`);
      return null;
    }
  };
  const listen =
    (subscribe: (l: (data: unknown) => void) => () => void) =>
    (listener: (message: PushMessage) => void) =>
      subscribe((data) => {
        const message = parseMessage(data);
        if (message) listener(message);
      });
  const tapped = listen(system.onTapped);

  return {
    supported: true,
    permission: async () => answer(await system.getPermission()),
    requestPermission: async () => {
      await system.ensureChannel();
      return answer(await system.requestPermission());
    },
    token,
    onTokenChange: (listener) =>
      system.onDeviceTokenChange(() => {
        void token().then((t) => t && listener(t));
      }),
    onReceived: listen(system.onReceived),
    onOpened: (listener) => {
      const stop = tapped(listener);
      // The tap that started the app happened before anyone listened: hand it over once, then forget it.
      void system.takeLaunchTap().then((data) => {
        const message = parseMessage(data);
        if (message) listener(message);
      });
      return stop;
    },
  };
}
