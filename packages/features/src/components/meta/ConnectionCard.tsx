import type { SocialConnection } from '@orderloop/contracts';
import { Badge, Button, Card, Row, Stack, Text } from '@orderloop/ui';
import { formatWhen } from '../../lib/format';
import { CONNECTION_STATUS } from '../../lib/meta';
import { SourceBadge } from './SourceBadge';

/**
 * One connected account: its name, whether it is Facebook or Instagram (or a mock), its status in plain words, and the
 * action that fixes it. People who cannot manage integrations see the status and no buttons.
 */
export function ConnectionCard({
  connection,
  canManage,
  canSignIn,
  busy,
  onReconnect,
  onDisconnect,
}: {
  connection: SocialConnection;
  canManage: boolean;
  /** Signing in with Meta needs a browser: the phone app can look and disconnect, not reconnect. */
  canSignIn: boolean;
  busy: boolean;
  onReconnect: (connection: SocialConnection) => void;
  onDisconnect: (connection: SocialConnection) => void;
}) {
  const status = CONNECTION_STATUS[connection.status];
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
    <Card variant="outlined" padding="md" role="group" aria-label={connection.displayName}>
      <Stack gap={3}>
        <Row gap={3} wrap justify="between" align="start">
          <Stack gap={2} grow style={{ minWidth: 220 }}>
            <Text variant="title">{connection.displayName}</Text>
            <Row gap={2} wrap>
              <SourceBadge provider={connection.provider} mock={connection.mock} />
              <Badge tone={status.tone} dot>
                {status.label}
              </Badge>
            </Row>
            {!!connection.username && (
              <Text variant="caption" tone="muted">{`@${connection.username}`}</Text>
            )}
          </Stack>
          {canManage && (
            <Row gap={2} wrap>
              {(needsSignIn || again) && canSignIn && (
                <Button loading={busy} onPress={() => onReconnect(connection)}>
                  {label}
                </Button>
              )}
              {connection.status !== 'disconnected' && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onPress={() => onDisconnect(connection)}
                >
                  Disconnect
                </Button>
              )}
            </Row>
          )}
        </Row>
        <Text tone="muted">{status.explanation}</Text>
        {!!connection.lastErrorMessage && connection.status !== 'active' && (
          <Text variant="small">{connection.lastErrorMessage}</Text>
        )}
        {(needsSignIn || again) && canManage && !canSignIn && (
          <Text variant="small">
            Reconnect from the web app: signing in with Meta needs a browser.
          </Text>
        )}
        <Text variant="caption" tone="muted">
          {`Connected ${formatWhen(connection.connectedAt)}`}
        </Text>
      </Stack>
    </Card>
  );
}
