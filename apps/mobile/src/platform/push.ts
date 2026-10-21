import Constants, { ExecutionEnvironment } from 'expo-constants';
import type * as DeviceModule from 'expo-device';
import type * as NotificationsModule from 'expo-notifications';
import { Platform } from 'react-native';
import { createPushPlatform, type PushSystem } from './pushPlatform';

const projectId: string | undefined =
  Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;

const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

// The notification modules are native. Expo Go has none, and a development build made before they were added lacks them:
// even importing them throws and takes the whole app down. So they are loaded defensively, and without them push is simply off.
function loadNative<T>(load: () => T): T | null {
  try {
    return load();
  } catch {
    return null;
  }
}
const Device = loadNative(() => require('expo-device') as typeof DeviceModule); // eslint-disable-line @typescript-eslint/no-require-imports
const Notifications = isExpoGo
  ? null
  : loadNative(() => require('expo-notifications') as typeof NotificationsModule); // eslint-disable-line @typescript-eslint/no-require-imports

const asPermission = (r: NotificationsModule.NotificationPermissionsStatus) => ({
  status: r.status,
  canAskAgain: r.canAskAgain,
});

const system: PushSystem = {
  os: Platform.OS,
  isDevice: Device?.isDevice ?? false,
  isExpoGo,
  nativeModulesMissing: !isExpoGo && (!Device || !Notifications),
  projectId,
  getPermission: async () => asPermission(await Notifications!.getPermissionsAsync()),
  requestPermission: async () => asPermission(await Notifications!.requestPermissionsAsync()),
  ensureChannel: async () => {
    if (Platform.OS !== 'android') return;
    await Notifications!.setNotificationChannelAsync('default', {
      name: 'OrderLoop alerts',
      importance: Notifications!.AndroidImportance.HIGH,
    });
  },
  getExpoToken: async (id) => (await Notifications!.getExpoPushTokenAsync({ projectId: id })).data,
  // A push that arrives while the app is open is shown as an in-app toast (see PushRegistration), not as a system banner.
  quietForeground: () =>
    Notifications!.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    }),
  onDeviceTokenChange: (listener) => {
    const subscription = Notifications!.addPushTokenListener(listener);
    return () => subscription.remove();
  },
  onReceived: (listener) => {
    const subscription = Notifications!.addNotificationReceivedListener((n) =>
      listener(n.request.content.data),
    );
    return () => subscription.remove();
  },
  onTapped: (listener) => {
    const subscription = Notifications!.addNotificationResponseReceivedListener((r) =>
      listener(r.notification.request.content.data),
    );
    return () => subscription.remove();
  },
  takeLaunchTap: async () => {
    const response = await Notifications!.getLastNotificationResponseAsync();
    if (response) await Notifications!.clearLastNotificationResponseAsync();
    return response?.notification.request.content.data ?? null;
  },
  log: (message) => console.info(`[push] ${message}`),
};

/** This phone's push notifications, for the shared app. */
export const pushPlatform = createPushPlatform(system);
