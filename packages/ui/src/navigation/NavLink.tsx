import type { ReactNode } from 'react';
import { Link } from './Link';
import { useNavigation } from './navigation';
import { useTheme } from '../theme/theme';
import { radius, space } from '../theme/tokens';

/** A menu entry that marks itself as the current page (visually and for screen readers) when the path matches. */
export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const { pathname } = useNavigation();
  const { colors } = useTheme();
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      variant="plain"
      weight="medium"
      {...({ 'aria-current': active ? 'page' : undefined } as object)}
      style={{
        paddingHorizontal: space[3],
        paddingVertical: space[2],
        borderRadius: radius.md,
        backgroundColor: active ? colors.primary : 'transparent',
        color: active ? colors.onPrimary : colors.foreground,
        overflow: 'hidden',
      }}
    >
      {children}
    </Link>
  );
}
