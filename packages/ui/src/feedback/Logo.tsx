import Svg, { Circle, Path, Rect } from '../theme/svg';
import { View } from 'react-native';
import { useT } from '../i18n';
import { Text } from '../Text';
import { useTheme } from '../theme/theme';

/** The OrderLoop mark: an indigo tile with a white loop and a teal node. Use the mark alone for favicons and avatars. */
export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" aria-hidden focusable={false}>
      <Rect width={32} height={32} rx={9} fill="#4f46e5" />
      <Path
        d="M22.5 11.2A8 8 0 1 0 24 16"
        stroke="#fff"
        strokeWidth={2.6}
        strokeLinecap="round"
        fill="none"
      />
      <Path
        d="M18.4 10.6l4.4.4-.6 4.3"
        stroke="#fff"
        strokeWidth={2.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Circle cx={16} cy={16} r={2.6} fill="#14b8a6" />
    </Svg>
  );
}

/** The mark with the "OrderLoop" wordmark ("Loop" in indigo, teal on dark). */
export function Logo({ size = 32, wordmark = true }: { size?: number; wordmark?: boolean }) {
  const t = useT();
  const { colors, scheme } = useTheme() as ReturnType<typeof useTheme> & { scheme?: string };
  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
      role="img"
      aria-label={t('OrderLoop')}
    >
      <LogoMark size={size} />
      {wordmark && (
        <Text
          variant="body"
          role="none"
          style={{ fontSize: size * 0.7, lineHeight: size, fontWeight: '700' }}
          aria-hidden
          verbatim
        >
          Order
          <Text
            variant="body"
            role="none"
            verbatim
            style={{
              fontSize: size * 0.7,
              fontWeight: '700',
              color: scheme === 'dark' ? colors.accent : colors.primary,
            }}
          >
            Loop
          </Text>
        </Text>
      )}
    </View>
  );
}
