import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Icon } from '../feedback/Icon';
import { Stack } from '../layout/Stack';
import { Text } from '../Text';
import { useTheme } from '../theme/theme';

export interface TimelineStep {
  key: string;
  title: string;
  /** Time or date line. */
  meta?: string | undefined;
  detail?: ReactNode;
  /** `done` is a teal tick, `current` an indigo ring, `todo` an empty circle, `problem` a red mark. */
  state: 'done' | 'current' | 'todo' | 'problem';
}

/** A vertical sequence of steps with a connecting line: order progress, shipment tracking. */
export function Timeline({ steps, label }: { steps: TimelineStep[]; label: string }) {
  const { colors } = useTheme();
  return (
    <View role="list" aria-label={label}>
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        const done = s.state === 'done';
        const problem = s.state === 'problem';
        return (
          <View key={s.key} role="listitem" style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ alignItems: 'center', width: 24 }}>
              <View
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 12,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: done ? colors.accent : problem ? colors.danger : colors.surface,
                  borderWidth: done || problem ? 0 : 2,
                  borderColor: s.state === 'current' ? colors.primary : colors.borderStrong,
                }}
              >
                {done ? <Icon name="check" size={14} color="#fff" strokeWidth={3} /> : null}
                {problem ? <Icon name="x" size={14} color="#fff" strokeWidth={3} /> : null}
                {s.state === 'current' ? (
                  <View
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      backgroundColor: colors.primary,
                    }}
                  />
                ) : null}
              </View>
              {!last && (
                <View
                  style={{
                    flex: 1,
                    width: 2,
                    minHeight: 16,
                    backgroundColor: done ? colors.accent : colors.border,
                  }}
                />
              )}
            </View>
            <Stack gap={1} grow style={{ paddingBottom: last ? 0 : 16 }}>
              <Text variant="label" tone={s.state === 'todo' ? 'muted' : 'default'}>
                {s.title}
              </Text>
              {s.meta ? (
                <Text variant="caption" tone="muted">
                  {s.meta}
                </Text>
              ) : null}
              {typeof s.detail === 'string' ? (
                <Text variant="small" tone="muted">
                  {s.detail}
                </Text>
              ) : (
                s.detail
              )}
            </Stack>
          </View>
        );
      })}
    </View>
  );
}
