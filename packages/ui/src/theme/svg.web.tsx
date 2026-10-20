import { createElement, type ReactNode } from 'react';

type Props = Record<string, unknown> & { children?: ReactNode };
const shape = (tag: string) =>
  function SvgShape(props: Props) {
    return createElement(tag, props);
  };

/** Web: the shapes are ordinary DOM SVG elements. The same names and props as react-native-svg, for the ones we use. */
export const Svg = shape('svg');
export default Svg;
export const Circle = shape('circle');
export const Defs = shape('defs');
export const G = shape('g');
export const Line = shape('line');
export const LinearGradient = shape('linearGradient');
export const Path = shape('path');
export const Polygon = shape('polygon');
export const Polyline = shape('polyline');
export const Rect = shape('rect');
export const Stop = shape('stop');
