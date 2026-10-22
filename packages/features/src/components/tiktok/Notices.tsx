import { Alert, Stack, Text } from '@orderloop/ui';
import {
  CURRENCY_TEXT,
  MOCK_NOTICE_TEXT,
  MOCK_NOTICE_TITLE,
  NO_BUYER_TEXT,
  NOT_TESTED_TEXT,
  READ_ONLY_TEXT,
} from '../../lib/tiktok';

/**
 * The notice that is always shown where simulated TikTok data appears. It says plainly that nothing is connected to TikTok,
 * so nobody takes a test order for a real sale or a mock shop for a working integration.
 */
export function TikTokMockNotice() {
  return (
    <Alert tone="warning" title={MOCK_NOTICE_TITLE} icon="alert">
      {MOCK_NOTICE_TEXT}
    </Alert>
  );
}

/** What this channel does and does not do: read only, untested with TikTok, other currency, no buyer data. */
export function TikTokFacts() {
  return (
    <Alert tone="info" title="About TikTok Shop in OrderLoop">
      <Stack gap={1}>
        <Text>{READ_ONLY_TEXT}</Text>
        <Text>{CURRENCY_TEXT}</Text>
        <Text>{NO_BUYER_TEXT}</Text>
        <Text>{NOT_TESTED_TEXT}</Text>
      </Stack>
    </Alert>
  );
}
