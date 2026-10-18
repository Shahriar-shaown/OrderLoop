import { Fragment } from 'react';
import { View } from 'react-native';
import { Icon } from './Icon';
import { Link } from './Link';
import { Row } from './Stack';
import { Text } from './Text';
import { useTheme } from './theme';

export interface Crumb {
  label: string;
  href?: string;
}

/** Where this page sits: Orders › #OL-24817. The last crumb is the current page. */
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  const { colors } = useTheme();
  return (
    <View role="navigation" aria-label="Breadcrumb">
      <Row gap={2} wrap>
        {items.map((c, i) => (
          <Fragment key={c.label + i}>
            {i > 0 && <Icon name="chevron-right" size={12} color={colors.muted} />}
            {c.href && i < items.length - 1 ? (
              <Link href={c.href} variant="inline" style={{ textDecorationLine: 'none' }}>
                {c.label}
              </Link>
            ) : (
              <Text
                variant="small"
                tone="muted"
                aria-current={i === items.length - 1 ? 'page' : undefined}
              >
                {c.label}
              </Text>
            )}
          </Fragment>
        ))}
      </Row>
    </View>
  );
}
