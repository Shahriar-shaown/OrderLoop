import { View } from 'react-native';
import { useTheme } from '../theme/theme';

export interface Segment {
  key: string;
  /** 0..1 share of the whole. */
  share: number;
  color: string;
}

/** A thin bar: a single fill (`value` 0..1) or several coloured segments that make up a whole (where the COD is). */
export function ProgressBar({
  value,
  segments,
  color,
  height = 8,
  label,
}: {
  value?: number;
  segments?: Segment[];
  color?: string;
  height?: number;
  label: string;
}) {
  const { colors } = useTheme();
  const parts: Segment[] = segments ?? [
    { key: 'v', share: Math.max(0, Math.min(1, value ?? 0)), color: color ?? colors.accent },
  ];
  return (
    <View
      role="progressbar"
      aria-label={label}
      {...(segments
        ? {}
        : {
            'aria-valuenow': Math.round((value ?? 0) * 100),
            'aria-valuemin': 0,
            'aria-valuemax': 100,
          })}
      style={{
        height,
        borderRadius: height / 2,
        backgroundColor: colors.subtle,
        flexDirection: 'row',
        overflow: 'hidden',
      }}
    >
      {parts.map((p) => (
        <View
          key={p.key}
          style={{ width: `${Math.max(0, p.share) * 100}%`, backgroundColor: p.color }}
        />
      ))}
    </View>
  );
}
