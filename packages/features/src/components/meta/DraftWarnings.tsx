import type { SocialDraft } from '@orderloop/contracts';
import { Alert, Stack, Text } from '@orderloop/ui';
import { warningText } from '../../lib/meta';

/** The reasons to look closer, in plain language (the code decides the wording, the server's sentence is the fallback). */
export function DraftWarnings({ warnings }: { warnings: SocialDraft['warnings'] }) {
  if (warnings.length === 0) return null;
  return (
    <Alert tone="warning" title="Check before you confirm">
      <Stack gap={1}>
        {warnings.map((w) => (
          <Text key={w.code} variant="small">
            {warningText(w.code, w.message)}
          </Text>
        ))}
      </Stack>
    </Alert>
  );
}
