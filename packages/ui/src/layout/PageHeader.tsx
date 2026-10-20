import { useEffect, type ReactNode } from 'react';
import { Breadcrumbs, type Crumb } from './Breadcrumbs';
import { useScreenChrome } from './screenChrome';
import { Stack } from './Stack';
import { Text } from '../Text';

/**
 * The title of a screen (the page's one h1), an optional explanation, badges beside the title, breadcrumbs above, and the
 * screen's main actions on the right (below the title on a narrow screen).
 */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
  badges,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  breadcrumbs?: Crumb[];
  badges?: ReactNode;
}) {
  const { titleInBar, setTitle } = useScreenChrome();
  useEffect(() => {
    if (titleInBar) setTitle?.(title);
  }, [titleInBar, setTitle, title]);
  return (
    <Stack gap={2}>
      {breadcrumbs && !titleInBar && <Breadcrumbs items={breadcrumbs} />}
      <Stack direction="row" justify="between" align="start" gap={3} wrap>
        <Stack gap={1} grow style={{ minWidth: 240 }}>
          {(!titleInBar || badges) && (
            <Stack direction="row" gap={3} align="center" wrap>
              {!titleInBar && (
                <Text variant="display" aria-level={1}>
                  {title}
                </Text>
              )}
              {badges}
            </Stack>
          )}
          {description && <Text tone="muted">{description}</Text>}
        </Stack>
        {actions && (
          <Stack direction="row" gap={2} wrap align="center">
            {actions}
          </Stack>
        )}
      </Stack>
    </Stack>
  );
}
