import { AutomationSettingsScreen } from '@orderloop/features';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function Automation() {
  return (
    <ScreenFrame title="Automation">
      <AutomationSettingsScreen />
    </ScreenFrame>
  );
}
