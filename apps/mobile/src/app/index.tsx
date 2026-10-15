import { createApiClient } from '@orderloop/api-client';
import type { ReadyResponse } from '@orderloop/contracts';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { env } from '@/lib/env';

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; ready: ReadyResponse }
  | { kind: 'error'; message: string };

export default function DevelopmentHome() {
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

  return (
    <View style={styles.container}>
      <Text style={styles.badge}>DEVELOPMENT BUILD - NOT A PRODUCT SCREEN</Text>
      <Text style={styles.title}>OrderLoop</Text>
      <Text style={styles.note}>
        Foundation only. No authentication or business features exist yet.
      </Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Backend connectivity</Text>
        <Text style={styles.row}>API URL: {env.API_URL}</Text>
        <Text style={styles.row}>Environment: {env.APP_ENV}</Text>
        {state.kind === 'idle' && <Text style={styles.row}>Status: not checked</Text>}
        {state.kind === 'loading' && <Text style={styles.row}>Status: checking...</Text>}
        {state.kind === 'ok' && (
          <>
            <Text style={styles.row}>Status: {state.ready.status}</Text>
            <Text style={styles.row}>PostgreSQL: {state.ready.checks.postgres}</Text>
            <Text style={styles.row}>Redis: {state.ready.checks.redis}</Text>
          </>
        )}
        {state.kind === 'error' && (
          <Text style={styles.row}>Status: unreachable ({state.message})</Text>
        )}
        <Pressable accessibilityRole="button" onPress={check} style={styles.button}>
          <Text style={styles.buttonText}>Check API health</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, gap: 12 },
  badge: {
    alignSelf: 'flex-start',
    backgroundColor: '#fef3c7',
    color: '#78350f',
    fontSize: 11,
    fontWeight: '700',
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  title: { fontSize: 32, fontWeight: '600' },
  note: { fontSize: 14, color: '#666' },
  card: { borderWidth: 1, borderColor: '#ccc', borderRadius: 6, padding: 16, gap: 4 },
  cardTitle: { fontSize: 14, fontWeight: '600', marginBottom: 4 },
  row: { fontSize: 13, fontFamily: 'Courier' },
  button: {
    marginTop: 12,
    backgroundColor: '#111',
    borderRadius: 6,
    paddingVertical: 10,
    alignItems: 'center',
  },
  buttonText: { color: '#fff', fontWeight: '600' },
});
