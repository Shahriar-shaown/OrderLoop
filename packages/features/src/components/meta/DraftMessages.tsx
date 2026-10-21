import type { SocialDraft } from '@orderloop/contracts';
import { Section, Stack, Text, useTheme } from '@orderloop/ui';
import { View } from 'react-native';
import { formatWhen } from '../../lib/format';

/**
 * What the customer actually wrote, word for word and with the time, oldest first: the thing every field below is checked
 * against. Attachments are named by kind only (nothing is downloaded).
 */
export function DraftMessages({ messages }: { messages: SocialDraft['messages'] }) {
  const { colors } = useTheme();
  return (
    <Section
      title="What the customer wrote"
      description="Word for word. Check the form below against it."
    >
      <Stack gap={3}>
        {messages.length === 0 && <Text tone="muted">No messages are stored for this draft.</Text>}
        {messages.map((m) => (
          <View
            key={m.id}
            style={{
              borderLeftWidth: 3,
              borderLeftColor: colors.primaryTint,
              paddingLeft: 12,
              gap: 4,
            }}
          >
            <Text variant="caption" tone="muted">
              {formatWhen(m.at)}
            </Text>
            {m.text !== null && <Text selectable>{m.text}</Text>}
            {m.attachmentTypes.length > 0 && (
              <Text variant="small" tone="muted">
                {`Attachment: ${m.attachmentTypes.join(', ')} (not shown)`}
              </Text>
            )}
          </View>
        ))}
      </Stack>
    </Section>
  );
}
