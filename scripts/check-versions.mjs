// Fails when workspace dependency versions drift from the pins in docs/architecture.md §2.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const EXACT = { react: '19.2.3', 'react-dom': '19.2.3', zod: '4.6.7' };
const TS = /^~?6\.0\.\d+$/; // Expo's template pins ~6.0.x; root pins 6.0.3

const dirs = ['.', ...['apps', 'packages'].flatMap((d) =>
  existsSync(join(root, d)) ? readdirSync(join(root, d)).map((n) => join(d, n)) : [])];

const errors = [];
for (const dir of dirs) {
  const file = join(root, dir, 'package.json');
  if (!existsSync(file)) continue;
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  for (const [name, want] of Object.entries(EXACT)) {
    if (deps[name] !== undefined && deps[name] !== want) errors.push(`${dir}: ${name} is "${deps[name]}", must be exactly "${want}"`);
  }
  if (deps.typescript !== undefined && !TS.test(deps.typescript)) errors.push(`${dir}: typescript is "${deps.typescript}", must be 6.0.x`);
}

// Expo SDK is the source of truth for React / React Native.
const expoManifest = join(root, 'apps/mobile/node_modules/expo/bundledNativeModules.json');
if (existsSync(expoManifest)) {
  const bundled = JSON.parse(readFileSync(expoManifest, 'utf8'));
  if (bundled.react !== EXACT.react) errors.push(`Expo SDK bundles react ${bundled.react}; update pins (EXACT.react=${EXACT.react})`);
  const rn = JSON.parse(readFileSync(join(root, 'apps/mobile/package.json'), 'utf8')).dependencies['react-native'];
  if (rn !== bundled['react-native']) errors.push(`react-native is "${rn}", Expo SDK bundles "${bundled['react-native']}"`);
} else {
  console.warn('warn: expo not installed, skipped Expo bundled-version check (run pnpm install)');
}

if (errors.length) {
  console.error('Version drift detected:\n' + errors.map((e) => '  - ' + e).join('\n'));
  process.exit(1);
}
console.log('versions ok');
