import { DashboardScreen } from '@orderloop/features';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function Dashboard() {
  return (
    <ScreenFrame tab verify>
      <DashboardScreen />
    </ScreenFrame>
  );
}
