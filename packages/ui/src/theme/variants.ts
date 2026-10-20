import { useMemo } from 'react';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';
import { useTheme, type Theme } from './theme';

/**
 * A tiny, typed "variants" system (the idea behind cva or Stitches), so every component declares its look once:
 *
 *   const useButtonStyle = createVariants((t) => ({
 *     base: { borderRadius: radius.md },
 *     variants: { tone: { primary: {...}, danger: {...} }, size: { sm: {...}, md: {...} } },
 *     defaults: { tone: 'primary', size: 'md' },
 *     compound: [{ when: { tone: 'primary' }, style: {...} }],
 *   }));
 *
 * The hook returns the merged styles for the chosen variant values, recomputed only when the theme or the choices change.
 * `createVariants` is for views; `createTextVariants` is for text and text inputs (their style types differ).
 */
export interface VariantConfig<
  V extends Record<string, Record<string, S>>,
  S extends ViewStyle | TextStyle = ViewStyle,
> {
  base?: S;
  variants: V;
  defaults?: { [K in keyof V]?: keyof V[K] };
  /** Extra styles that apply when several variants take specific values together. */
  compound?: { when: { [K in keyof V]?: keyof V[K] }; style: S }[];
}

export type VariantProps<V extends Record<string, Record<string, ViewStyle | TextStyle>>> = {
  [K in keyof V]?: keyof V[K] | undefined;
};

function variantsFor<S extends ViewStyle | TextStyle>() {
  return function create<V extends Record<string, Record<string, S>>>(
    factory: (theme: Theme) => VariantConfig<V, S>,
  ) {
    return function useVariants(props: VariantProps<V>): StyleProp<S> {
      const theme = useTheme();
      const config = useMemo(() => factory(theme), [theme]);
      const key = JSON.stringify(props);
      return useMemo(() => {
        const chosen = {} as Record<string, string>;
        for (const name of Object.keys(config.variants)) {
          const given = (props as Record<string, unknown>)[name];
          const fallback = (config.defaults as Record<string, unknown> | undefined)?.[name];
          chosen[name] = String(given ?? fallback ?? '');
        }
        const styles: S[] = [];
        if (config.base) styles.push(config.base);
        for (const [name, value] of Object.entries(chosen)) {
          const style = config.variants[name]?.[value];
          if (style) styles.push(style);
        }
        for (const rule of config.compound ?? []) {
          const matches = Object.entries(rule.when).every(
            ([name, value]) => chosen[name] === String(value),
          );
          if (matches) styles.push(rule.style);
        }
        return styles;
      }, [config, key]);
    };
  };
}

export const createVariants = variantsFor<ViewStyle>();
export const createTextVariants = variantsFor<TextStyle>();
