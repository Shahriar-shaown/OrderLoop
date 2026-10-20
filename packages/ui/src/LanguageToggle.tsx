import { Pressable, View } from 'react-native';
import { LOCALES, LOCALE_NAMES, useLocale } from './i18n';
import { Text } from './Text';
import { useTheme } from './theme';
import { radius, space } from './tokens';

/** Switches the language of the app (English or Bangla). The choice is remembered by the app's `LocaleStore`. */
export function LanguageToggle() {
  const { colors } = useTheme();
  const { locale, setLocale } = useLocale();
  return (
    <View
      role="radiogroup"
      aria-label="Language"
      style={{
        flexDirection: 'row',
        alignSelf: 'flex-start',
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.md,
        overflow: 'hidden',
      }}
    >
      {LOCALES.map((l) => {
        const selected = locale === l;
        return (
          <Pressable
            key={l}
            role="radio"
            aria-checked={selected}
            // The names stay in their own language whatever the app shows, so a person can always find theirs.
            aria-label={LOCALE_NAMES[l]}
            onPress={() => setLocale(l)}
            style={{
              paddingHorizontal: space[4],
              paddingVertical: space[1],
              minHeight: 44,
              justifyContent: 'center',
              backgroundColor: selected ? colors.primary : colors.surface,
            }}
          >
            <Text
              variant="fine"
              weight={selected ? 'semibold' : 'medium'}
              style={{ color: selected ? colors.onPrimary : colors.foreground }}
            >
              {LOCALE_NAMES[l]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
