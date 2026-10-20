import {
  Card,
  Icon,
  Logo,
  Screen,
  SkipLink,
  Stack,
  Text,
  ThemeSelect,
  radius,
  space,
  useBreakpoint,
  useNavigation,
  useTheme,
  type IconName,
  LanguageSelect,
} from '@orderloop/ui';
import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';

const BENEFITS: { icon: IconName; title: string; text: string }[] = [
  {
    icon: 'box',
    title: 'Every order in one place',
    text: 'Take orders, follow their status and keep stock in step.',
  },
  {
    icon: 'truck',
    title: 'Couriers built in',
    text: 'Book Pathao or Steadfast parcels and follow delivery.',
  },
  {
    icon: 'wallet',
    title: 'COD you can trust',
    text: 'Match courier settlements to collected cash and see what is still outstanding.',
  },
];

/** The quiet brand panel beside the form on wider screens: what OrderLoop does, in plain facts. */
function BrandPanel() {
  const { colors } = useTheme();
  return (
    <View
      style={{
        width: 340,
        padding: space[8],
        justifyContent: 'center',
        gap: space[6],
        backgroundColor: colors.primarySoft,
      }}
    >
      <Text variant="title">One loop. Every order.</Text>
      <Stack gap={5}>
        {BENEFITS.map((b) => (
          <Stack key={b.title} direction="row" gap={3} align="start">
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: radius.md,
                backgroundColor: colors.surface,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name={b.icon} size={18} color={colors.primary} />
            </View>
            <Stack gap={1} grow>
              <Text variant="label">{b.title}</Text>
              {/* Default ink, not muted: muted grey on the indigo tint is below 4.5:1. */}
              <Text variant="small">{b.text}</Text>
            </Stack>
          </Stack>
        ))}
      </Stack>
    </View>
  );
}

/**
 * The frame of every signed-out screen: the logo, then a card with the title, a short description and the form, and on a
 * wider screen a brand panel beside it. `footer` holds the secondary links (Create an account, Back to sign in).
 */
export function AuthLayout({
  title,
  description,
  footer,
  children,
}: {
  title: string;
  description?: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  const { isWide } = useBreakpoint();
  const navigation = useNavigation();
  return (
    <>
      <SkipLink />
      <Screen width="lg">
        <Stack gap={6} align="center" style={{ paddingVertical: space[4] }}>
          {/* Theme and language: quiet dropdowns in the top corner, out of the way of the form. */}
          <View
            style={{
              width: '100%',
              maxWidth: isWide ? 920 : 440,
              flexDirection: 'row',
              justifyContent: 'flex-end',
              gap: space[1],
            }}
          >
            <ThemeSelect />
            <LanguageSelect />
          </View>
          {/* A Pressable, not a Link: a Link is inline text on a phone, and its line box clips the logo tile. */}
          <Pressable role="link" aria-label="OrderLoop home" onPress={() => navigation.push('/')}>
            <Logo size={36} />
          </Pressable>
          <Card
            padding="none"
            style={{
              width: '100%',
              maxWidth: isWide ? 920 : 440,
              flexDirection: isWide ? 'row' : 'column',
              overflow: 'hidden',
            }}
          >
            <View style={{ flex: 1, minWidth: 0, padding: isWide ? space[8] : space[5] }}>
              <Stack gap={5}>
                <Stack gap={1}>
                  <Text variant="display">{title}</Text>
                  {description ? <Text tone="muted">{description}</Text> : null}
                </Stack>
                {children}
                {footer ? (
                  <View
                    style={{
                      borderTopWidth: 1,
                      borderTopColor: colors.border,
                      paddingTop: space[4],
                      gap: space[2],
                    }}
                  >
                    {footer}
                  </View>
                ) : null}
              </Stack>
            </View>
            {isWide ? <BrandPanel /> : null}
          </Card>
        </Stack>
      </Screen>
    </>
  );
}
