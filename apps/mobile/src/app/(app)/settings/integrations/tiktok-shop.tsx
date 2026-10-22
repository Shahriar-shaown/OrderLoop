import { TikTokIntegrationsScreen } from '@orderloop/features';
import { ScreenFrame } from '@/chrome/ScreenFrame';

/** Status, sync and the mock tools. Signing in with TikTok needs a browser, so the screen points to the web app instead. */
export default function TikTokIntegrations() {
  return (
    <ScreenFrame title="Integrations">
      <TikTokIntegrationsScreen browserSignIn={false} />
    </ScreenFrame>
  );
}
