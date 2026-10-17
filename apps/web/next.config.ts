import type { NextConfig } from 'next';
import { resolve } from 'node:path';

// Next only reads .env from apps/web; the repo keeps a single root .env.
try {
  process.loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // No root .env (e.g. CI injects variables directly).
}

/** `.web.*` files are the web implementations of components that differ by platform (see packages/ui). */
const WEB_EXTENSIONS = [
  '.web.tsx',
  '.web.ts',
  '.web.jsx',
  '.web.js',
  '.tsx',
  '.ts',
  '.jsx',
  '.js',
  '.mjs',
  '.json',
];

const nextConfig: NextConfig = {
  // The end-to-end tests build into their own folder so they never disturb a running `next dev`.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  // The shared UI and feature packages are TypeScript sources written against React Native; Next compiles them.
  transpilePackages: ['@orderloop/ui', '@orderloop/features', 'react-native-web'],
  turbopack: {
    // React Native components render in the browser through react-native-web.
    resolveAlias: { 'react-native': 'react-native-web' },
    resolveExtensions: WEB_EXTENSIONS,
  },
  webpack: (config) => {
    // The same mapping for `next dev --webpack` / `next build --webpack`.
    config.resolve.alias = { ...config.resolve.alias, 'react-native$': 'react-native-web' };
    config.resolve.extensions = WEB_EXTENSIONS;
    return config;
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
