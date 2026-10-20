import { CodReconciliationScreen } from '@orderloop/features';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function Screen() {
  return (
    <ScreenFrame title="COD reconciliation">
      <CodReconciliationScreen />
    </ScreenFrame>
  );
}
