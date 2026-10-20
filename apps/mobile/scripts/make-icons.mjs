// Renders the app icon, the Android adaptive icon layers, the splash image and the favicon from the OrderLoop mark (the same
// loop as apps/web/app/icon.svg). Run `node scripts/make-icons.mjs` after changing the mark; the PNGs are committed.
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../assets/images');
mkdirSync(out, { recursive: true });

const INDIGO = '#4f46e5';
const TEAL = '#14b8a6';
// The loop with its arrow head and the teal dot, in a 32-unit box; `color` is the stroke, `dot` the dot (or none).
const mark = (color, dot) => `
  <path d="M22.5 11.2A8 8 0 1 0 24 16" stroke="${color}" stroke-width="2.6" stroke-linecap="round" fill="none"/>
  <path d="M18.4 10.6l4.4.4-.6 4.3" stroke="${color}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  ${dot ? `<circle cx="16" cy="16" r="2.6" fill="${dot}"/>` : ''}`;
const scaled = (inner, k) =>
  `<g transform="translate(16 16) scale(${k}) translate(-16 -16)">${inner}</g>`;
const svg = (body, size = 32) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">${body}</svg>`,
  );
const png = (name, body, size) =>
  sharp(svg(body), { density: (72 * size) / 32 })
    .resize(size, size)
    .png()
    .toFile(resolve(out, name));

await Promise.all([
  // iOS and the store listing: full bleed, no transparency (the system rounds the corners).
  png(
    'icon.png',
    `<rect width="32" height="32" fill="${INDIGO}"/>${scaled(mark('#fff', TEAL), 1.12)}`,
    1024,
  ),
  // Android adaptive icon: the mark alone on transparency, inside the 66 % safe zone; the colour layer is set in app.config.ts.
  png('android-icon-foreground.png', scaled(mark('#fff', TEAL), 1.0), 1024),
  png('android-icon-background.png', `<rect width="32" height="32" fill="${INDIGO}"/>`, 1024),
  // Android 13 themed icon: a single colour, the system tints it.
  png('android-icon-monochrome.png', scaled(mark('#000', '#000'), 1.0), 1024),
  // Splash: the rounded tile with the mark, on the splash background colour.
  png(
    'splash-icon.png',
    `<rect x="1" y="1" width="30" height="30" rx="9" fill="${INDIGO}"/>${mark('#fff', TEAL)}`,
    1024,
  ),
  png(
    'favicon.png',
    `<rect width="32" height="32" rx="9" fill="${INDIGO}"/>${mark('#fff', TEAL)}`,
    96,
  ),
]);
console.log('icons written to', out);
