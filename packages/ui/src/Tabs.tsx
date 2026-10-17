import { Pressable, ScrollView, View } from 'react-native';
import { Text } from './Text';
import { useTheme } from './theme';
import { space, touchTarget } from './tokens';

export interface TabItem {
  value: string;
  label: string;
}

/** A row of tabs (it scrolls sideways when they do not fit). Controlled: the screen keeps `value` and shows the matching panel. */
export function Tabs({
  items,
  value,
  onChange,
  label,
}: {
  items: TabItem[];
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const { colors } = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ flexGrow: 1 }}
    >
      <View
        role="tablist"
        aria-label={label}
        style={{
          flexGrow: 1,
          flexDirection: 'row',
          gap: space[1],
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        }}
      >
        {items.map((item) => {
          const selected = item.value === value;
          return (
            <Pressable
              key={item.value}
              role="tab"
              aria-selected={selected}
              onPress={() => onChange(item.value)}
              style={{
                minHeight: touchTarget,
                justifyContent: 'center',
                paddingHorizontal: space[4],
                borderBottomWidth: 2,
                borderBottomColor: selected ? colors.primary : 'transparent',
                marginBottom: -1,
              }}
            >
              <Text weight={selected ? 'bold' : 'medium'} tone={selected ? 'primary' : 'muted'}>
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}
