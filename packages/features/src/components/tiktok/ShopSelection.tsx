import type { ConnectTikTokShopsResult } from '@orderloop/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Row,
  Section,
  Stack,
  Text,
  useNavigation,
  useToast,
} from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../../core/runtime';
import { tiktokErrorText } from '../../forms/errors';
import { useFormState } from '../../forms/forms';
import { invalidateTikTok, typeText, useTikTokSession } from '../../lib/tiktok';
import { QueryBoundary } from '../../shell/QueryBoundary';

/**
 * The step after signing in with TikTok: choose which shops to connect. A shop that is already connected cannot be chosen; a
 * shop that could not be connected says why, and the others still are.
 */
export function ShopSelection({ sessionId, home }: { sessionId: string; home: string }) {
  const api = useApi();
  const toast = useToast();
  const navigation = useNavigation();
  const client = useQueryClient();
  const query = useTikTokSession(sessionId, true);
  const form = useFormState({});
  const [chosen, setChosen] = useState<string[]>([]);
  const [result, setResult] = useState<ConnectTikTokShopsResult | null>(null);
  const session = query.data;
  const nameOf = (id: string) => session?.shops.find((s) => s.id === id)?.name ?? id;

  async function connect() {
    if (!session || chosen.length === 0) return;
    let outcome: ConnectTikTokShopsResult | null = null;
    const ok = await form.run(async () => {
      outcome = await api.tiktokShop.connect({ sessionId, shopIds: chosen });
      await invalidateTikTok(client);
    });
    const done = outcome as ConnectTikTokShopsResult | null;
    if (!ok || !done) return;
    if (done.failures.length === 0) {
      toast.success(
        `Connected ${done.connections.length} shop${done.connections.length === 1 ? '' : 's'}`,
      );
      navigation.replace(home);
    } else {
      setResult(done);
      setChosen([]);
    }
  }

  return (
    <Section
      title="Choose the shops to connect"
      description={
        session?.reconnectConnectionId
          ? 'Choose the shop you are reconnecting.'
          : 'OrderLoop only reads orders from the shops you choose: it never changes anything on TikTok.'
      }
    >
      <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading your shops">
        {session && (
          <Stack gap={3}>
            {!!form.formError && <Alert tone="error">{form.formError}</Alert>}
            {result && (
              <Alert tone="warning" title="Some shops could not be connected">
                <Stack gap={2}>
                  {result.failures.map((f) => (
                    <Stack key={f.shopId} gap={1}>
                      <Text weight="medium" verbatim>
                        {nameOf(f.shopId)}
                      </Text>
                      <Text>{tiktokErrorText(f.code, f.message)}</Text>
                    </Stack>
                  ))}
                  {result.connections.length > 0 && (
                    <Text>{`${result.connections.length} other shop${result.connections.length === 1 ? ' was' : 's were'} connected.`}</Text>
                  )}
                </Stack>
              </Alert>
            )}
            {session.shops.length === 0 && (
              <Text tone="muted">
                TikTok did not list any shop you can connect. Make sure you are signed in as the
                shop owner and try again.
              </Text>
            )}
            {session.shops.map((shop) => (
              <Card key={shop.id} variant="outlined" padding="sm">
                <Row gap={3} wrap justify="between">
                  <Checkbox
                    label={shop.name}
                    disabled={shop.alreadyConnected}
                    checked={chosen.includes(shop.id)}
                    onChange={(on) =>
                      setChosen((all) =>
                        on ? [...all, shop.id] : all.filter((x) => x !== shop.id),
                      )
                    }
                  />
                  <Row gap={2} wrap>
                    {!!shop.region && <Badge tone="info">{shop.region}</Badge>}
                    {!!shop.sellerType && <Badge>{typeText(shop.sellerType)}</Badge>}
                    {shop.alreadyConnected && <Badge>Already connected</Badge>}
                  </Row>
                </Row>
              </Card>
            ))}
            <Row gap={2} wrap>
              <Button loading={form.busy} disabled={chosen.length === 0} onPress={connect}>
                Connect selected
              </Button>
              <Button variant="tertiary" onPress={() => navigation.replace(home)}>
                {result ? 'Done' : 'Cancel'}
              </Button>
            </Row>
          </Stack>
        )}
      </QueryBoundary>
      {query.isError && (
        <Button variant="tertiary" onPress={() => navigation.replace(home)}>
          Back to integrations
        </Button>
      )}
    </Section>
  );
}
