import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { createPushPlatform, type PushSystem } from './pushPlatform';

const projectId: string | undefined =
  Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;

const asPermission = (r: Notifications.NotificationPermissionsStatus) => ({
  status: r.status,
  canAskAgain: r.canAskAgain,
});

const system: PushSystem = {
  os: Platform.OS,
  isDevice: Device.isDevice,
  isExpoGo: Constants.executionEnvironment === ExecutionEnvironment.StoreClient,
  projectId,
  getPermission: async () => asPermission(await Notifications.getPermissionsAsync()),
  requestPermission: async () => asPermission(await Notifications.requestPermissionsAsync()),
  ensureChannel: async () => {
    if (Platform.OS !== 'android') return;
    await Notifications.setNotificationChannelAsync('default', {
      name: 'OrderLoop alerts',
      importance: Notifications.AndroidImportance.HIGH,
    });
  },
  getExpoToken: async (id) => (await Notifications.getExpoPushTokenAsync({ projectId: id })).data,
  // A push that arrives while the app is open is shown as an in-app toast (see PushRegistration), not as a system banner.
  quietForeground: () =>
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    }),
  onDeviceTokenChange: (listener) => {
    const subscription = Notifications.addPushTokenListener(listener);
    return () => subscription.remove();
  },
  onReceived: (listener) => {
    const subscription = Notifications.addNotificationReceivedListener((n) =>
      listener(n.request.content.data),
    );
    return () => subscription.remove();
  },
  onTapped: (listener) => {
    const subscription = Notifications.addNotificationResponseReceivedListener((r) =>
      listener(r.notification.request.content.data),
    );
    return () => subscription.remove();
  },
  takeLaunchTap: async () => {
    const response = await Notifications.getLastNotificationResponseAsync();
    if (response) await Notifications.clearLastNotificationResponseAsync();
    return response?.notification.request.content.data ?? null;
  },
  log: (message) => console.warn(`[push] ${message}`),
};

/** This phone's push notifications, for the shared app. */
export const pushPlatform = createPushPlatform(system);
