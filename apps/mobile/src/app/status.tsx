import { createApiClient } from '@orderloop/api-client';
import type { ReadyResponse } from '@orderloop/contracts';
import {
  Alert,
  Badge,
  Button,
  KeyValueList,
  PageHeader,
  Screen,
  Section,
  Stack,
} from '@orderloop/ui';
import { useCallback, useState } from 'react';
import { env } from '@/lib/env';

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; ready: ReadyResponse }
  | { kind: 'error'; message: string };

/**
 * A development screen built only from the shared `@orderloop/ui` components (the same ones the web app uses). The product
 * screens (`@orderloop/features`) get mounted here once the native session storage exists.
 */
export default function StatusScreen() {
  const [state, setState] = useState<State>({ kind: 'idle' });

  const check = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const ready = await createApiClient({ baseUrl: env.API_URL }).health.ready();
      setState({ kind: 'ok', ready });
    } catch (error) {
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }, []);

  const status =
    state.kind === 'idle'
      ? 'not checked'
      : state.kind === 'loading'
        ? 'checking…'
        : state.kind === 'ok'
          ? state.ready.status
          : 'unreachable';

  return (
    <Screen width="md">
      <Stack gap={5}>
        <Badge tone="warning">Development build, not a product screen</Badge>
        <PageHeader
          title="OrderLoop"
          description="Foundation only: sign-in and the catalog live in the web app for now."
        />
        <Section title="Backend connectivity">
          <KeyValueList
            items={[
              { label: 'API URL', value: env.API_URL },
              { label: 'Environment', value: env.APP_ENV },
              { label: 'Status', value: status },
              ...(state.kind === 'ok'
                ? [
                    { label: 'PostgreSQL', value: state.ready.checks.postgres },
                    { label: 'Redis', value: state.ready.checks.redis },
                  ]
                : []),
            ]}
          />
          {state.kind === 'error' && <Alert tone="error">{state.message}</Alert>}
          <Button loading={state.kind === 'loading'} onPress={check}>
            Check API health
          </Button>
        </Section>
      </Stack>
    </Screen>
  );
}
