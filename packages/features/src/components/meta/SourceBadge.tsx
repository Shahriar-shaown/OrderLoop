import type { SocialProvider } from '@orderloop/contracts';
import { Badge, Row } from '@orderloop/ui';
import { PROVIDER_LABEL } from '../../lib/meta';

/** Where a connection or draft comes from: Facebook or Instagram, and Mock when it is simulated. */
export function SourceBadge({ provider, mock }: { provider: SocialProvider; mock: boolean }) {
  return (
    <Row gap={1} wrap>
      <Badge tone="info">{PROVIDER_LABEL[provider]}</Badge>
      {mock && <Badge tone="warning">Mock</Badge>}
    </Row>
  );
}
