import { WorkspacesScreen } from '@orderloop/features';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function Workspaces() {
  return (
    <ScreenFrame title="Your businesses">
      <WorkspacesScreen />
    </ScreenFrame>
  );
}
