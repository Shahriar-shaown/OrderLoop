import { useCan } from '@orderloop/features';
import { Button, Sheet, Stack, useNavigation, type IconName } from '@orderloop/ui';

/** The "+" of the tab bar: what a person can start from anywhere. */
export function CreateSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const can = useCan();
  const navigation = useNavigation();
  const actions: { label: string; icon: IconName; href: string }[] = [
    ...(can('orders:write')
      ? [{ label: 'New order', icon: 'box' as const, href: '/orders/new' }]
      : []),
    ...(can('catalog:write')
      ? [{ label: 'New product', icon: 'layers' as const, href: '/products/new' }]
      : []),
    ...(can('orders:write')
      ? [{ label: 'New customer', icon: 'users' as const, href: '/customers?new=1' }]
      : []),
  ];
  return (
    <Sheet open={open} onClose={onClose} title="Create">
      <Stack gap={2}>
        {actions.map((a) => (
          <Button
            key={a.href}
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
