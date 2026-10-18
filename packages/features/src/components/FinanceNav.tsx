import { Row, Button } from '@orderloop/ui';
import { useCan } from '../permissions';

const ITEMS = [
  { href: '/finance', label: 'Overview' },
  { href: '/finance/outstanding', label: 'Outstanding COD' },
  { href: '/finance/settlements', label: 'Settlements' },
  { href: '/finance/issues', label: 'Unmatched and discrepancies' },
];

/** The finance pages, side by side. */
export function FinanceNav({ current }: { current: string }) {
  const can = useCan();
  if (!can('finance:read')) return null;
  return (
    <Row gap={2} wrap>
      {ITEMS.map((i) => (
        <Button
          key={i.href}
          href={i.href}
          size="sm"
          variant={i.href === current ? 'primary' : 'secondary'}
        >
          {i.label}
        </Button>
      ))}
    </Row>
  );
}
