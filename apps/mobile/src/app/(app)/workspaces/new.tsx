import { WorkspaceCreateScreen } from '@orderloop/features';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function NewWorkspace() {
  return (
    <ScreenFrame title="New business">
      <WorkspaceCreateScreen />
    </ScreenFrame>
  );
}
