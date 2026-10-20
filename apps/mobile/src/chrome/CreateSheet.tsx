import { useCreateActions } from '@orderloop/features';
import { Button, Sheet, Stack, useNavigation } from '@orderloop/ui';

/** The "+" of the tab bar: what a person can start from anywhere. */
export function CreateSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const actions = useCreateActions();
  const navigation = useNavigation();
  return (
    <Sheet open={open} onClose={onClose} title="Create">
      <Stack gap={2}>
        {actions.map((a) => (
          <Button
            key={a.key}
            variant="secondary"
            size="lg"
            icon={a.icon}
            fullWidth
            onPress={() => {
              onClose();
              navigation.push(a.href);
            }}
          >
            {a.label}
          </Button>
        ))}
      </Stack>
    </Sheet>
  );
}
