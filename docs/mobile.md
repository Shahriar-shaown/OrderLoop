# The mobile app (iOS and Android)

`apps/mobile` is an Expo SDK 57 / React Native app. It is **not** a web view: every screen is native, and it uses the same
backend API as the web dashboard. The screens themselves are the shared ones in `packages/features` and `packages/ui`
(see [web.md](web.md)); the app adds what only a phone needs: native navigation, secure storage, the network, the language
and the app's identity.

## What is in it

| Area                                                                                                                  | Where it lives                                                                |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Sign-in, sign-up, forgot / reset password, verify e-mail, accept invitation                                           | `src/app/*.tsx` (shared auth screens)                                         |
| Business switching and creation                                                                                       | header (tap the business) and More → _Switch or add a business_               |
| Overview (KPIs, quick actions, needs-attention, COD, low stock, recent orders, courier performance)                   | tab **Home**                                                                  |
| Orders: list with status tabs, search, filters; detail; create; edit; confirm; cancel (with a reason); status changes | tab **Orders**, `src/app/(app)/orders/*`                                      |
| Customer lookup, profile, order history                                                                               | More → _Customers_                                                            |
| Products, variants, stock, receive / adjust / damage, locations, categories, suppliers                                | More → _Products & inventory_                                                 |
| Courier booking and tracking (Pathao, Steadfast, simulated), shipment list and detail                                 | order page → _Courier & tracking_, tab **Shipments**                          |
| COD summary, outstanding COD, statement import, settlements, discrepancies                                            | More → _COD reconciliation_                                                   |
| Analytics and profit                                                                                                  | More → _Analytics & profit_                                                   |
| Profile, language (English / বাংলা), colour theme, sign out                                                           | tab **More**                                                                  |
| Social orders (drafts from Facebook / Instagram messages), Integrations (status, mock tools)                          | More → _Social orders_, _Integrations_                                        |
| Team and business settings                                                                                            | More → _Team & staff_, _Business settings_                                    |
| Notifications (bell in the header), their preferences, automation rules                                               | header bell, More → _Notifications_, _Notification preferences_, _Automation_ |

### Navigation

Expo Router (React Navigation underneath, so the platform's own stack and transitions):

```
src/app/_layout.tsx            providers, splash screen held until the session is known
src/app/index.tsx              session restore → Home or sign-in
src/app/login.tsx …            signed-out screens
src/app/(app)/_layout.tsx      the signed-in area: auth gate + native stack (back button, title)
src/app/(app)/(tabs)/…         Home, Orders, Shipments, More + the raised "+" (create sheet)
src/app/(app)/orders/[id]/…    pushed screens: native bar with back button and the screen's own title ("#1003")
```

`ScreenFrame` (`src/chrome/ScreenFrame.tsx`) is the frame of every signed-in screen: safe areas, keyboard avoidance, pull to
refresh, the offline banner. The bottom bar (`src/chrome/TabBar.tsx`) and the tab header follow the Figma mobile frames
(`docs/design/figma/mobile`).

### Code layout

```
apps/mobile/
  app.config.ts, eas.json        identity per build variant; build profiles
  scripts/                       icons, env loading (the test API and demo data live in the repo's scripts/mobile/)
  src/
    app/                         the routes: thin files that mount a shared screen inside a ScreenFrame
    chrome/                      what surrounds the screens: ScreenFrame, TabBar, MobileHeader, CreateSheet, MoreScreen
    platform/                    the phone's side of the app: runtime, env, secure token store, language store,
                                 connectivity, and Providers (the router adapter + the shared providers)
    navigation.ts                the tabs and the More menu (the single list the routes test checks)
packages/features/src/          the screens, flows and shared logic
  core/                          session, runtime, auth, permissions, connectivity (offline guard), query cache
  forms/                         form state, zod forms, error messages, form fields and small dialogs
  lib/                           formatting, money, and the labels and hooks of each area (orders, finance, couriers…)
  screens/<area>/                auth, orders, catalog, logistics, insights, workspace (+ their tests)
  components/<area>/             the pieces of those screens
  shell/                         app frame, providers, header menus, search, banners
  i18n/                          the Bangla catalogue of the app
packages/ui/src/                 components in folders: inputs, overlays, data, layout, navigation, feedback, theme;
                                 i18n/ is the translation engine (catalog, translate, dates, provider)
```

### Touch targets, safe areas, keyboard

- Controls on a phone are at least 44 pt (`touchTarget` in the design tokens; the tab bar items are 48 pt).
- Insets: `react-native-safe-area-context` (notch, home indicator, Android gesture bar) in the tab bar, header and frames.
- Forms: `automaticallyAdjustKeyboardInsets` (iOS), `softwareKeyboardLayoutMode: resize` (Android), `keyboardShouldPersistTaps`,
  keyboard dismissed on drag, numeric keypads for amounts and phone numbers.

## Configuration

| Setting          | Local                                                            | Builds                                  |
| ---------------- | ---------------------------------------------------------------- | --------------------------------------- |
| API address      | `EXPO_PUBLIC_API_URL` in the repository `.env`                   | `eas.json`, `env` of each build profile |
| Environment name | `EXPO_PUBLIC_APP_ENV` (`development` / `staging` / `production`) | same                                    |
| App identity     | `APP_VARIANT` (`development` / `preview` / `production`)         | same                                    |

`app.config.ts` turns `APP_VARIANT` into the app name and identifiers, so the three builds install side by side:

| Variant     | Name                | iOS bundle id / Android package | URL scheme          |
| ----------- | ------------------- | ------------------------------- | ------------------- |
| development | OrderLoop (Dev)     | `com.orderloop.app.dev`         | `orderloop-dev`     |
| preview     | OrderLoop (Preview) | `com.orderloop.app.preview`     | `orderloop-preview` |
| production  | OrderLoop           | `com.orderloop.app`             | `orderloop`         |

The identifiers and the placeholder API addresses in `eas.json` (`api.example.com`) are to be replaced with yours before the
first store build. Icons and the splash screen are generated from the OrderLoop mark: `node scripts/make-icons.mjs`
(`assets/images`). The Android manifest is limited to `INTERNET`, `ACCESS_NETWORK_STATE` and `VIBRATE`.

**Release builds.** `app.config.ts` throws for the `preview` and `production` variants unless `EXPO_PUBLIC_API_URL` is an `https://` address (and not the `example.com` placeholder); only the development variant may use `http://`. The CI mobile job sets one (`https://api.ci.orderloop.test`). Android's `allowBackup` is `false`, so the device's cloud backup never copies the app's data.

**Localhost from a phone.** A simulator on the same Mac reaches `localhost`. An Android emulator does not: either run
`adb reverse tcp:4000 tcp:4000` (what we use) or point `EXPO_PUBLIC_API_URL` at `http://10.0.2.2:4000`. A physical phone needs
the computer's LAN address.

## Running it

```bash
pnpm services:up                         # Postgres, Redis (and `pnpm services:mail` for Mailpit)
pnpm --filter @orderloop/api build && pnpm --filter @orderloop/api start
pnpm --filter @orderloop/mobile start    # Metro; press i (iOS) or a (Android), or scan the QR code with Expo Go
```

Handy for trying the app without touching development data: `node scripts/mobile/test-api.mjs` runs an API on :4100
against the isolated test database, and `node scripts/mobile/seed-demo.mjs http://localhost:4100` creates a business with
products, stock and orders and prints the sign-in.

### Expo Go and development builds

Expo Go is enough for everything the app uses today (secure store, network state, localisation, haptics, storage). Because
`expo-dev-client` is installed, `expo start` targets a development build by default: add `--go` to open Expo Go instead
(`pnpm --filter @orderloop/mobile start -- --go`). Use a **development build** when you need the exact native configuration (identifiers, icons, permissions) or a native module Expo
Go does not contain:

```bash
cd apps/mobile
eas build --profile development --platform android   # an .apk
eas build --profile development --platform ios        # a simulator build (.app), or add a device to your Apple account
eas build --profile preview --platform all            # internal test builds (APK / ad-hoc)
eas build --profile production --platform all         # store builds, build numbers raised by EAS
npx expo run:android   # or run:ios: builds locally with a native toolchain (below)
```

Platform requirements:

- **iOS**: macOS with Xcode (the iOS Simulator and `expo run:ios` need it), an Apple Developer account for devices and the
  store, CocoaPods (`brew install cocoapods`; the Mac's own Ruby is too old). Point the command-line tools at Xcode once
  (`sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`) and run pod installs with a UTF-8 locale
  (`export LANG=en_US.UTF-8`). The bundle id must match the App ID in your account.
  **iOS 27 SDK:** apps built with it must use the UIScene life cycle or iOS closes them at launch. The Expo SDK 57
  template does not yet, so `plugins/withIosScenes.js` switches the generated project to Expo's scene delegate (the Info.plist
  scene manifest and `ExpoReactNativeFactoryProvider`); delete the plugin when the template does it. The `ios/` and
  `android/` folders are generated by `expo prebuild` and are not committed.
- **Android**: JDK 17, Android Studio with an SDK and an emulator (or a device with USB debugging), and `adb` on the PATH.
  Store builds are `.aab` files signed by EAS (or your own upload key).
- EAS: `npm i -g eas-cli`, `eas login`, `eas init` (sets `EAS_PROJECT_ID`).

## Email links (universal and app links)

The emails (verify, reset password, invitation) link to the web app's pages. Without more, a phone opens them in the browser.
To open the app instead, set `APP_WEB_HOST` (for example `app.example.com`) when building: `app.config.ts` then declares the
associated domain (iOS) and the verified intent filters (Android) for `/verify-email`, `/reset-password` and
`/accept-invitation`. The web host must also serve, over https and without a redirect:

- `/.well-known/apple-app-site-association` (your Apple team id and the bundle id, with those three paths), and
- `/.well-known/assetlinks.json` (the package name and the SHA-256 fingerprint of the app signing key).

The app already has the three screens; they read the `token` from the link. Until a domain is set up, people finish these
flows in the web app, which is fully supported.

## Notifications and push

The bell in the header shows the unread count (polled every minute while the app is in front, and again when it returns to
the foreground) and opens the shared Notifications screen. Preferences and Automation are under More and are the same shared
screens as on the web (see [web.md](web.md) and [automation.md](automation.md)).

Push (Expo notifications, `expo-notifications` + `expo-device`) is kept to a small seam:

- `packages/features/src/core/push.ts` defines `PushPlatform` (what a phone provides) and `PushRegistrar` (the rules). The web
  passes no platform, so everything is a no-op there. `apps/mobile/src/platform/pushPlatform.ts` makes the platform from a
  `PushSystem` (plain functions); `push.ts` fills that from Expo's modules. Both are unit-tested with fakes.
- **When it asks.** Never at start-up. The Notifications screen shows "Get alerts on this phone" until the person chooses
  (_Turn on_ shows the system question; _Not now_ hides it for the session), and Notification preferences always has a _This
  phone_ section with the same button and the state. The Android channel `default` is created before the first question or token.
- **Registering.** After sign-in, if notifications are already allowed, the Expo push token is sent with `POST /v1/push-devices`
  (an upsert), and again whenever the push service issues a new one.
- **Signing out.** `DELETE /v1/push-devices/:token` is sent first, best effort: a failure or three seconds of silence never
  holds sign-out up, and if signing out then fails (offline) the phone is registered again.
- **A push while the app is open** shows an in-app toast and refreshes the bell (no system banner). **A tap** (also the one
  that launched the app, kept until the session is restored) calls `POST /v1/notifications/:id/read`, which returns the
  notification, and opens its screen. The push itself carries only `{ kind, id }`.
- **No project id, no push.** The token needs the EAS project id (`EAS_PROJECT_ID` becomes `extra.eas.projectId`). Without it, on
  a simulator, in Expo Go (which cannot receive push) or on the web, the app offers nothing, asks nothing and logs one line
  `[push] Push notifications are off: ...`. Real delivery also needs Firebase credentials for Android and an Apple key for iOS in the
  EAS project (see Expo's push setup), and `PUSH_PROVIDER=expo` on the server; with the default `dev` provider pushes are only recorded.
- Not verified on a phone from this repository: a real device and an EAS project are needed.

## Orders on the phone

The order screens are the shared ones (see [web.md](web.md#orders-returns-closing-couriers)): marking an order returned asks for a quantity and condition per line, Delivered and Returned need `orders:close` (hidden for staff, with the reason), and an order whose cash to collect has paisa cannot be booked with a courier (the form says what to do). Controls keep 44 pt targets and the return steppers sit one line per row, so they fit a 360 pt-wide phone.

## Facebook and Instagram messages

Social orders (list and review, `/social-orders`) and Integrations (`/settings/integrations/meta`) are the same shared screens as on the web (see [web.md](web.md) and [meta.md](meta.md)). Signing in with Meta needs a browser, so on the phone Integrations shows each account's status, lets an owner or admin disconnect, and says "Connect from the web app" for connecting and reconnecting. In mock mode the mock account and test-message tools work here too, under the same "Mock integration: not connected to Meta" notice. The draft review form scrolls above the keyboard like every other form.

## Deleting data

The same screens as the web: **More > Your account** (delete my account), **Settings > Delete this business** (owners), **Customers >
a customer > Erase personal data**, and the export of the customer list. A business that is scheduled for deletion is replaced, inside the
signed-in layout, by one screen with the date, _Cancel deletion_ for an owner, other businesses and Sign out (`TenantDeletedScreen`). Deleting
the account clears the refresh token from secure storage and returns to sign-in. Nothing is kept on the device that an erasure would need to
remove: the app stores only the refresh token, the language and the push registration (removed with the account). See
[privacy-and-deletion.md](privacy-and-deletion.md).

## Sessions, offline and expiry

- **Tokens.** The refresh token lives in the platform's secure storage (Keychain / Keystore, `expo-secure-store`); the short
  access token only in memory. No `x-client` header is sent, so the API returns the refresh token in the body.
- **Session expiry.** If the server stops accepting the session (revoked, expired, signed out elsewhere) the app goes to
  sign-in with "Your session has expired" and returns to where the person was after signing in again.
- **No connection at launch.** The saved session is kept; the app shows "Cannot reach OrderLoop" with _Try again_, not a spinner.
- **Offline while using it.** A banner says so; what is loaded stays readable; reads refetch on reconnect and when the app
  returns to the foreground (so changes made on another device appear).
- **Nothing is sent silently.** While offline every request that changes data (orders, status changes, payments, courier
  bookings, stock) is refused at once with "You are offline. Nothing was sent." (`withOfflineGuard`); mutations are never
  queued or paused. Booking a courier stays duplicate-safe on top (idempotency keys).
- How "offline" is decided: the OS network state, confirmed against the app's own server (`/health/live`), because the OS flag
  is wrong behind captive portals and on emulators; while offline the server is asked again every five seconds.

## Language

English and Bangla, chosen in _More → Language_ (and on the sign-in screen); the default is the phone's language, and the
choice is kept on the device. The English text in the source is the translation key; `Text`, `Button` and `TextField`
translate what they render, so screens did not change. Catalogues: `packages/ui/src/i18n/bn.ts`,
`packages/features/src/i18n/bn.ts` (+ `bn.extra.ts`, `bn.automation.ts`, `bn.meta.ts`). Entries may contain `{name}` placeholders for text built at run time.
Digits in prices, counts and dates are shown as Bengali numerals; order numbers and codes keep theirs. Known limits: explanatory sentences that the **API** writes (finance caveats, import warnings) are translated by pattern and stay English where no pattern exists, and a few sentences with inline bold text stay English. Screen-reader labels are translated (a test in `packages/ui` fails on a raw `aria-label`). To find what is still English:
`TEST_LOCALE=bn MISSING_OUT=/tmp/missing pnpm --filter @orderloop/features test` renders every tested screen in Bangla and
writes the untranslated strings; `node scripts/i18n-extract.mjs` lists all source strings.

## Shared backend

There is one API. An order created or changed on the web, on a phone, or by an integration is the same row for everyone:
the phone reads it on its next load, on pull to refresh, and when the app returns to the foreground; the web dashboard
likewise. (Verified: an order made in the app showed in the API listing at once, and an order made through the API showed in
the app's Orders tab.)

## Tests

- `pnpm --filter @orderloop/mobile test`: routes (every tab and menu entry has a screen, groups and dynamic segments),
  refresh-token storage, language storage, connectivity (OS vs. server, recovery, failure reports), the push seam
  (permission, token, listeners, when it stays silent).
- `pnpm --filter @orderloop/features test`: the shared screens and flows (orders create/edit/confirm/cancel, inventory,
  couriers, COD, team, auth), the offline guard (reads pass, every write is refused before it is sent, via the real API
  client), session expiry, restore without a connection, the Bangla catalogue (placeholders, no repeats), date and digit
  localisation.
- The web end-to-end suite (`pnpm --filter @orderloop/web test:e2e`) covers the same screens in a browser at phone width.

## How it was verified

- **Android** (Pixel-class emulator, API 37, Expo Go, API through `adb reverse`): sign-in, session restore,
  business header, Home with real figures, Orders list with the pending badge, order detail, creating and confirming an order
  with the keyboard open, cancelling with a reason, confirming a pending order, booking a simulated courier and seeing the
  shipment, COD, Products & inventory, Customers, More, language switch to Bangla and back, dark mode, launching with no
  connection (retry screen, recovery), a revoked session (sign-in with the expiry message), an order created through the API
  appearing in the app.
- **iOS** (Xcode 27.1, iPhone 17 simulator, iOS 27.0, a native development build made with `expo run:ios`,
  `com.orderloop.app.dev`, API on the Mac's localhost): the build, install and launch (after the scene-life-cycle plugin; before
  it iOS closed the app at launch), the app icon, sign-in with the iOS keyboard, the Keychain-stored session restoring after
  the app was killed and relaunched, Home (quick actions, KPIs, native tab bar with the raised "+", safe areas), the create
  sheet, the Orders list, an order's page with the native bar and back chevron, the order form with customer search, More,
  the switch to Bangla (Bengali text, digits and dates, kept across a relaunch), launching with the server stopped ("Cannot
  reach OrderLoop" with Try again) and recovering with Try again. The flows that are the same shared code as on Android
  (confirm, cancel with a reason, courier booking, COD, session expiry) were exercised on Android only: run them once on iOS
  before a release. Not tried on iOS: a physical device, the iPad layout, VoiceOver.
