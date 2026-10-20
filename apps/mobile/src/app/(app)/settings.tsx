import { WorkspaceSettingsScreen } from '@orderloop/features';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function Settings() {
  return (
    <ScreenFrame title="Settings">
      <WorkspaceSettingsScreen />
    </ScreenFrame>
  );
}
