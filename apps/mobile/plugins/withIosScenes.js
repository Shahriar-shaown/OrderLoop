/**
 * Moves the generated iOS project to the UIScene life cycle.
 *
 * Apps built with the iOS 27 SDK are refused at launch ("UIScene life cycle is required") unless they use scenes, and the
 * project template of Expo SDK 57 still generates the old single-window setup. Expo ships the scene delegate
 * (`EXExpoAppSceneDelegate`: it creates the window and starts React Native in it); the app only has to
 *   1. declare it in Info.plist (`UIApplicationSceneManifest`),
 *   2. stop creating the window itself in `AppDelegate`, and
 *   3. let `AppDelegate` hand its React Native factory over (`ExpoReactNativeFactoryProvider`).
 * Remove this plugin once the template does it.
 */
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

const SCENE_DELEGATE = 'EXExpoAppSceneDelegate';

const START_REACT_NATIVE_IN_APP_DELEGATE =
  /\n#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\(\n[\s\S]*?launchOptions: launchOptions\)\n#endif\n/;

function adoptScenesInAppDelegate(source) {
  if (source.includes('ExpoReactNativeFactoryProvider')) return source; // already done

  const withProvider = source.replace(
    /class AppDelegate: ExpoAppDelegate \{/,
    'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {',
  );
  const withoutWindow = withProvider.replace(
    START_REACT_NATIVE_IN_APP_DELEGATE,
    '\n    // The scene delegate (EXExpoAppSceneDelegate) creates the window and starts React Native in it.\n',
  );
  if (withProvider === source || withoutWindow === withProvider)
    throw new Error(
      'withIosScenes: the generated AppDelegate.swift does not look as expected; update plugins/withIosScenes.js',
    );
  return withoutWindow;
}

module.exports = function withIosScenes(config) {
  config = withInfoPlist(config, (c) => {
    c.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: SCENE_DELEGATE,
          },
        ],
      },
    };
    return c;
  });
  return withAppDelegate(config, (c) => {
    c.modResults.contents = adoptScenesInAppDelegate(c.modResults.contents);
    return c;
  });
};
