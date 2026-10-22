import type { TikTokConnection } from '@orderloop/contracts';
import { Badge, Button, Card, Row, Stack, Text } from '@orderloop/ui';
import { formatWhen } from '../../lib/format';
import { connectionStatus, errorCodeText, typeText } from '../../lib/tiktok';
import { MockBadge } from './Badges';

/**
 * One connected shop: its name, region and seller type, its status in plain words and the action that fixes it, when it was
 * last checked, and the last error. People who cannot manage integrations see the status and no buttons.
 */
export function ShopCard({
  connection,
  canManage,
  canSignIn,
  busy,
  onReconnect,
  onDisconnect,
  onSync,
}: {
  connection: TikTokConnection;
  canManage: boolean;
  /** Signing in with TikTok needs a browser: the phone app can look, sync and disconnect, not reconnect. */
  canSignIn: boolean;
  busy: boolean;
  onReconnect: (connection: TikTokConnection) => void;
  onDisconnect: (connection: TikTokConnection) => void;
  onSync: (connection: TikTokConnection) => void;
}) {
  const status = connectionStatus(connection.status);
  const live = !connection.mock;
  const needsSignIn =
    live && (connection.status === 'needs_reconnect' || connection.status === 'permission_error');
  const again = live && connection.status === 'disconnected';
  const label =
    connection.status === 'permission_error'
      ? 'Reconnect and approve all permissions'
      : again
        ? 'Connect again'
        : 'Reconnect';
  return (
    <Card variant="outlined" padding="md" role="group" aria-label={connection.shopName}>
      <Stack gap={3}>
        <Row gap={3} wrap justify="between" align="start">
          <Stack gap={2} grow style={{ minWidth: 220 }}>
            <Text variant="title" verbatim>
              {connection.shopName}
            </Text>
            <Row gap={2} wrap>
              {connection.mock && <MockBadge />}
              <Badge tone={status.tone} dot>
                {status.label}
              </Badge>
              {!!connection.region && <Badge tone="info">{connection.region}</Badge>}
              {!!connection.sellerType && <Badge>{typeText(connection.sellerType)}</Badge>}
            </Row>
            {!!connection.currency && (
              <Text variant="caption" tone="muted">
                {`Shop currency: ${connection.currency}`}
              </Text>
            )}
          </Stack>
          {canManage && (
            <Row gap={2} wrap>
              {connection.status === 'active' && (
                <Button
                  variant="secondary"
                  loading={busy}
                  accessibilityLabel={`Sync now, ${connection.shopName}`}
                  onPress={() => onSync(connection)}
                >
                  Sync now
                </Button>
              )}
              {(needsSignIn || again) && canSignIn && (
                <Button loading={busy} onPress={() => onReconnect(connection)}>
                  {label}
                </Button>
              )}
              {connection.status !== 'disconnected' && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  accessibilityLabel={`Disconnect ${connection.shopName}`}
                  onPress={() => onDisconnect(connection)}
                >
                  Disconnect
                </Button>
              )}
            </Row>
          )}
        </Row>
        <Text tone="muted">{status.explanation}</Text>
        {connection.status !== 'active' && !!connection.lastErrorCode && (
          <Text variant="small">{errorCodeText(connection.lastErrorCode)}</Text>
        )}
        {connection.status !== 'active' && !!connection.lastErrorMessage && (
          <Text variant="small" tone="muted" verbatim>
            {connection.lastErrorMessage}
          </Text>
        )}
        {(needsSignIn || again) && canManage && !canSignIn && (
          <Text variant="small">
            Reconnect from the web app: signing in with TikTok needs a browser.
          </Text>
        )}
        <Text variant="caption" tone="muted">
          {connection.lastSyncedAt
            ? `Last synced ${formatWhen(connection.lastSyncedAt)}`
            : 'Not synced yet'}
        </Text>
      </Stack>
    </Card>
  );
}
