import { Alert } from '@orderloop/ui';
import { MOCK_NOTICE_TEXT, MOCK_NOTICE_TITLE } from '../../lib/meta';

/**
 * The notice that is always shown where simulated Meta data appears. It says plainly that nothing is connected to Meta,
 * so nobody takes a test message for a real customer or a mock account for a working integration.
 */
export function MockNotice() {
  return (
    <Alert tone="warning" title={MOCK_NOTICE_TITLE} icon="alert">
      {MOCK_NOTICE_TEXT}
    </Alert>
  );
}
