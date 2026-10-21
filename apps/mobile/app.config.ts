import type { ConfigContext, ExpoConfig } from 'expo/config';
import pkg from './package.json';

/**
 * One app, three builds. `APP_VARIANT` (set per profile in eas.json) picks the name and the application identifiers, so a
 * development build, an internal preview and the store release can be installed side by side on the same phone.
 * The API address is not here: it is `EXPO_PUBLIC_API_URL`, set per profile in eas.json and in the repository's .env locally.
 */
type Variant = 'development' | 'preview' | 'production';
const requested = process.env.APP_VARIANT as Variant | undefined;
// A cloud build that forgot to say which variant it is must stop, not quietly ship as the development app.
if (!requested && process.env.EAS_BUILD_PROFILE)
  throw new Error(
    `APP_VARIANT is not set for the EAS build profile "${process.env.EAS_BUILD_PROFILE}" (see eas.json)`,
  );
const variant = requested ?? 'development';
// Release builds must point at a real server: the placeholder addresses of eas.json are for you to replace.
if (variant !== 'development' && /(^|\.)example\.com\b/.test(process.env.EXPO_PUBLIC_API_URL ?? ''))
  throw new Error(
    `EXPO_PUBLIC_API_URL is still the placeholder (${process.env.EXPO_PUBLIC_API_URL}): set your server's address in eas.json`,
  );

// Preview and store builds carry customers' data: they must talk to the server over TLS.
if (variant !== 'development' && !/^https:\/\//.test(process.env.EXPO_PUBLIC_API_URL ?? ''))
  throw new Error(
    `EXPO_PUBLIC_API_URL must be an https address for the ${variant} build (got "${process.env.EXPO_PUBLIC_API_URL ?? ''}")`,
  );

const IDS: Record<Variant, { name: string; id: string; scheme: string }> = {
  development: { name: 'OrderLoop (Dev)', id: 'com.orderloop.app.dev', scheme: 'orderloop-dev' },
  preview: {
    name: 'OrderLoop (Preview)',
    id: 'com.orderloop.app.preview',
    scheme: 'orderloop-preview',
  },
  production: { name: 'OrderLoop', id: 'com.orderloop.app', scheme: 'orderloop' },
};
const { name, id, scheme } = IDS[variant];

const INDIGO = '#4F46E5';

/**
 * The web app's address, when emails should open this app instead of the browser: the links in verification, password-reset
 * and invitation emails are https addresses of the web app, so they reach the app only as universal links (iOS) and app links
 * (Android) for that host. Needs the host's `.well-known` files too: see docs/mobile.md. Unset, links open in the browser.
 */
const webHost = process.env.APP_WEB_HOST;
const EMAIL_LINK_PATHS = ['/verify-email', '/reset-password', '/accept-invitation'];

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name,
  slug: 'orderloop',
  // The marketing version. Build numbers (iOS) and version codes (Android) are raised by EAS on every store build.
  version: process.env.APP_VERSION ?? '1.0.0',
  scheme,
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  icon: './assets/images/icon.png',
  runtimeVersion: { policy: 'appVersion' },
  ios: {
    bundleIdentifier: id,
    supportsTablet: true,
    ...(webHost ? { associatedDomains: [`applinks:${webHost}`] } : {}),
    icon: './assets/images/icon.png',
    infoPlist: {
      // The app only uses the platform's own TLS: no export-compliance questions at upload.
      ITSAppUsesNonExemptEncryption: false,
      CFBundleAllowMixedLocalizations: true,
      CFBundleLocalizations: ['en', 'bn'],
    },
  },
  android: {
    package: id,
    // The refresh token lives in the Keystore and cannot be restored on another phone anyway: keep the rest of the app's data out
    // of cloud backups too.
    allowBackup: false,
    adaptiveIcon: {
      backgroundColor: INDIGO,
      foregroundImage: './assets/images/android-icon-foreground.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
    // Only what the app uses: the network, its state (to tell offline from online) and haptics. No storage, no camera, no
    // location. The overlay permission is for the development client's menu and is not wanted in a release.
    permissions: ['INTERNET', 'ACCESS_NETWORK_STATE', 'VIBRATE'],
    blockedPermissions: [
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      ...(variant === 'production' ? ['android.permission.SYSTEM_ALERT_WINDOW'] : []),
    ],
    ...(webHost
      ? {
          intentFilters: [
            {
              action: 'VIEW',
              autoVerify: true,
              data: EMAIL_LINK_PATHS.map((pathPrefix) => ({
                scheme: 'https',
                host: webHost,
                pathPrefix,
              })),
              category: ['BROWSABLE', 'DEFAULT'],
            },
          ],
        }
      : {}),
    softwareKeyboardLayoutMode: 'resize',
    predictiveBackGestureEnabled: false,
  },
  web: { favicon: './assets/images/favicon.png' },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-localization',
    // Push notifications. `default` is the Android channel the app creates before it asks to notify (see platform/push.ts).
    ['expo-notifications', { color: INDIGO, defaultChannel: 'default' }],
    // iOS 27 refuses apps that do not use the scene life cycle; the Expo template does not yet (see the plugin).
    './plugins/withIosScenes',
    [
      'expo-splash-screen',
      {
        image: './assets/images/splash-icon.png',
        imageWidth: 144,
        backgroundColor: '#F8FAFC',
        dark: { image: './assets/images/splash-icon.png', backgroundColor: '#0B1220' },
      },
    ],
  ],
  experiments: { typedRoutes: true },
  extra: {
    appVariant: variant,
    packageVersion: pkg.version,
    ...(process.env.EAS_PROJECT_ID ? { eas: { projectId: process.env.EAS_PROJECT_ID } } : {}),
  },
});
