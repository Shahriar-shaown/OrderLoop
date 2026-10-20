import { View } from 'react-native';
import { Button } from '../Button';
import { Row } from '../layout/Stack';
import { Text } from '../Text';
import { useBreakpoint } from '../layout/useBreakpoint';

/** The page numbers to show: the first, the last, and a window around the current page, with gaps as `null`. */
export function pageWindow(page: number, pages: number): (number | null)[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const out: (number | null)[] = [1];
  const from = Math.max(2, page - 1);
  const to = Math.min(pages - 1, page + 1);
  if (from > 2) out.push(null);
  for (let p = from; p <= to; p++) out.push(p);
  if (to < pages - 1) out.push(null);
  out.push(pages);
  return out;
}

/**
 * "Showing 1–10 of 248" with Previous, numbered pages and Next. For a list read by cursor (no page numbers), pass `onPrevious`
 * and `onNext` with `hasPrevious` / `hasNext` instead of `page` and `pages`.
 */
export function Pagination({
  summary,
  page,
  pages,
  onPage,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
}: {
  summary: string;
  page?: number;
  pages?: number;
  onPage?: (page: number) => void;
  hasPrevious?: boolean;
  hasNext?: boolean;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const { isMobile } = useBreakpoint();
  const numbered = page !== undefined && pages !== undefined && onPage;
  const prevOk = numbered ? page > 1 : !!hasPrevious;
  const nextOk = numbered ? page < pages : !!hasNext;
  return (
    <Row justify="between" gap={3} wrap style={{ paddingVertical: 12, paddingHorizontal: 16 }}>
      <Text variant="small" tone="muted" numeric>
        {summary}
      </Text>
      <Row gap={2} role="navigation" aria-label="Pages">
        <Button
          size="sm"
          variant="secondary"
          disabled={!prevOk}
          onPress={() => (numbered ? onPage(page - 1) : onPrevious?.())}
        >
          Previous
        </Button>
        {numbered &&
          !isMobile &&
          pageWindow(page, pages).map((p, i) =>
            p === null ? (
              <View key={`gap${i}`} style={{ minWidth: 24, alignItems: 'center' }}>
                <Text tone="muted">…</Text>
              </View>
            ) : (
              <Button
                key={p}
                size="sm"
                variant={p === page ? 'primary' : 'secondary'}
                aria-current={p === page ? 'page' : undefined}
                onPress={() => onPage(p)}
              >
                {String(p)}
              </Button>
            ),
          )}
        <Button
          size="sm"
          variant="secondary"
          disabled={!nextOk}
          onPress={() => (numbered ? onPage(page + 1) : onNext?.())}
        >
          Next
        </Button>
      </Row>
    </Row>
  );
}
