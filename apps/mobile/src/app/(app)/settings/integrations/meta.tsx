import { MetaIntegrationsScreen } from '@orderloop/features';
import { ScreenFrame } from '@/chrome/ScreenFrame';

/** Status and the mock tools. Signing in with Meta needs a browser, so the screen points to the web app instead. */
export default function Integrations() {
  return (
    <ScreenFrame title="Integrations">
      <MetaIntegrationsScreen browserSignIn={false} />
    </ScreenFrame>
  );
}
