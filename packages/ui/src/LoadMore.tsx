import { Button } from './Button';
import { Stack } from './Stack';

/** The "Load more" button under a cursor-paginated list. Renders nothing when the list is complete. */
export function LoadMore({
  hasNext,
  loading,
  onPress,
}: {
  hasNext: boolean;
  loading: boolean;
  onPress: () => void;
}) {
  if (!hasNext) return null;
  return (
    <Stack align="center">
      <Button variant="secondary" loading={loading} onPress={onPress}>
        Load more
      </Button>
    </Stack>
  );
}
