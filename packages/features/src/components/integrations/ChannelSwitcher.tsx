import { Tabs, useNavigation, type TabItem } from '@orderloop/ui';
import { META_PATH, TIKTOK_PATH } from '../../lib/tiktok';

export type Channel = 'meta' | 'tiktok';

const CHANNELS: (TabItem & { href: string })[] = [
  { value: 'meta', label: 'Facebook and Instagram', href: META_PATH },
  { value: 'tiktok', label: 'TikTok Shop', href: TIKTOK_PATH },
];

/** The two sales channels the Integrations area covers. Sits at the top of both pages; each is its own page and address. */
export function ChannelSwitcher({ current }: { current: Channel }) {
  const navigation = useNavigation();
  return (
    <Tabs
      variant="segmented"
      label="Sales channel"
      items={CHANNELS.map(({ value, label }) => ({ value, label }))}
      value={current}
      onChange={(value) => {
        const next = CHANNELS.find((c) => c.value === value);
        if (next && value !== current) navigation.push(next.href);
      }}
    />
  );
}
