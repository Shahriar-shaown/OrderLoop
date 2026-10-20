import Svg, { Circle, Line, Path, Polygon, Polyline, Rect } from '../theme/svg';
import { ICONS, type IconName, type Shape } from './icons';
import { useTheme } from '../theme/theme';
import { useT } from '../i18n';

export type IconProps = {
  name: IconName;
  size?: number;
  /** A palette colour or any CSS colour. Defaults to the surrounding text colour (the foreground). */
  color?: string;
  strokeWidth?: number;
  /** Icons that carry meaning on their own need a label; decorative ones are hidden from assistive technology. */
  label?: string;
};

function Draw({ shape }: { shape: Shape }) {
  switch (shape[0]) {
    case 'p':
      return <Path d={shape[1]} />;
    case 'c':
      return <Circle cx={shape[1]} cy={shape[2]} r={shape[3]} />;
    case 'r':
      return (
        <Rect x={shape[1]} y={shape[2]} width={shape[3]} height={shape[4]} rx={shape[5] ?? 0} />
      );
    case 'l':
      return <Line x1={shape[1]} y1={shape[2]} x2={shape[3]} y2={shape[4]} />;
    case 'pl':
      return <Polyline points={shape[1]} />;
    case 'pg':
      return <Polygon points={shape[1]} />;
  }
}

/** One icon from the set, drawn as SVG on the web and on native alike. */
export function Icon({ name, size = 18, color, strokeWidth = 2, label }: IconProps) {
  const { colors } = useTheme();
  const t = useT();
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? colors.foreground}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...(label
        ? { role: 'img', 'aria-label': t(label) }
        : { 'aria-hidden': true, focusable: false })}
    >
      {ICONS[name].map((shape, i) => (
        <Draw key={i} shape={shape} />
      ))}
    </Svg>
  );
}
