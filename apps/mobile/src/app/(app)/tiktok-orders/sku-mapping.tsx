import { TikTokOrdersScreen } from '@orderloop/features';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function TikTokSkuMapping() {
  return (
    <ScreenFrame title="SKU mapping">
      <TikTokOrdersScreen view="sku-mapping" />
    </ScreenFrame>
  );
}
