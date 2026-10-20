import type { ReactNode } from 'react';
import {
  type GestureResponderEvent,
  type TextProps as RNTextProps,
  type TextStyle,
} from 'react-native';
import { useContext } from 'react';
import { NavigationContext } from './navigation';
import { Text } from '../Text';
import { useTheme } from '../theme/theme';

export interface LinkProps extends Omit<RNTextProps, 'onPress' | 'style'> {
  style?: TextStyle;
  href: string;
  children: ReactNode;
  /** `inline` is coloured and underlined (in a sentence); `plain` inherits the text colour (in menus, tables). */
  variant?: 'inline' | 'plain';
  /** A different site: opened normally instead of through the app's router. */
  external?: boolean;
  weight?: 'normal' | 'medium' | 'bold';
  onPress?: () => void;
}

/**
 * Navigation. On the web it is a real `<a href>` (middle click, "open in new tab", and crawlers all work); a plain click
 * is handled by the app's router so the page does not reload. On native it is pressable text that calls the router.
 */
/** Shared by Link and Button-with-href: a plain click goes through the router; "open in new tab" gestures are left alone. */
export function useLinkPress(href: string, external = false, onPress?: () => void) {
  // Optional until a link is actually followed, so a Button without an href works anywhere.
  const navigation = useContext(NavigationContext);
  return (event?: GestureResponderEvent) => {
    onPress?.();
    if (external) return; // let the browser follow the href
    const e = event as unknown as
      | {
          metaKey?: boolean;
          ctrlKey?: boolean;
          shiftKey?: boolean;
          button?: number;
          preventDefault?: () => void;
        }
      | undefined;
    if (e && (e.metaKey || e.ctrlKey || e.shiftKey || (e.button !== undefined && e.button !== 0)))
      return;
    e?.preventDefault?.();
    if (!navigation)
      throw new Error('Navigation is missing: wrap the app in <NavigationContext.Provider>');
    navigation.push(href);
  };
}

/** The extra props that make the web element a real `<a>`; ignored by native. */
export const webLinkProps = (href: string, external = false): object => ({
  href,
  ...(external ? { hrefAttrs: { target: '_blank', rel: 'noopener noreferrer' } } : {}),
});

export function Link({
  href,
  children,
  variant = 'inline',
  external = false,
  weight,
  onPress,
  style,
  ...rest
}: LinkProps) {
  const { colors } = useTheme();
  const handle = useLinkPress(href, external, onPress);
  const webProps = webLinkProps(href, external);
  return (
    <Text
      role="link"
      {...(weight ? { weight } : {})}
      {...webProps}
      onPress={handle}
      style={[
        variant === 'inline'
          ? { color: colors.primary, textDecorationLine: 'underline' }
          : { textDecorationLine: 'none' },
        style,
      ]}
      {...rest}
    >
      {children}
    </Text>
  );
}
