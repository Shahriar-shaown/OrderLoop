import { createConnectivityStore } from '@orderloop/features';
import * as Network from 'expo-network';
import { env } from './env';

/**
 * Whether the app can work, from two sources. The operating system says whether there is a network; when it says there is
 * none (airplane mode, no Wi-Fi or data) the app asks its own server before believing it, because the OS flag is wrong in
 * places where our server is still reachable: behind a captive portal, on a Wi-Fi without internet, on emulators. Only when
 * the server cannot be reached either does the shared app pause reads and refuse writes (see `withOfflineGuard`), and while
 * it is offline the server is asked again every few seconds so recovery is noticed even without an OS event.
 */
const store = createConnectivityStore(true);
export const connectivity = {
  ...store,
  /** A request got no answer: check the server before the next one, so the banner does not wait for an OS event. */
  reportFailure: () => void serverReachable().then((ok) => store.set(ok)),
};

const PROBE_TIMEOUT_MS = 3000;
const RECHECK_MS = 5000;

async function serverReachable(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${env.API_URL}/health/live`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

let recheck: ReturnType<typeof setInterval> | undefined;

async function evaluate(state: Network.NetworkState): Promise<void> {
  if (state.isConnected !== false) {
    store.set(true);
    return;
  }
  store.set(await serverReachable());
}

function watchWhileOffline(): void {
  store.subscribe(() => {
    if (store.isOnline()) {
      if (recheck) clearInterval(recheck);
      recheck = undefined;
    } else if (!recheck) {
      recheck = setInterval(() => {
        void serverReachable().then((ok) => store.set(ok));
      }, RECHECK_MS);
    }
  });
}

watchWhileOffline();
Network.getNetworkStateAsync()
  .then(evaluate)
  .catch(() => undefined);
Network.addNetworkStateListener((s) => void evaluate(s));
