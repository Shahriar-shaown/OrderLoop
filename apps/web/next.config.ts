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

const isProduction = process.env.NODE_ENV === 'production';

/**
 * The browser's own defences that do not change per request. The Content-Security-Policy is set per request, with a nonce,
 * by `proxy.ts`.
 */
function securityHeaders() {
  return [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    // Only over TLS: sent on a plain http://localhost it would be ignored, but a production build behind https keeps it.
    ...(isProduction
      ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]
      : []),
  ];
}

/**
 * `NEXT_OUTPUT=standalone` (set by deploy/Dockerfile only) makes `next build` write a self-contained server under
 * `.next/standalone` for the container image. The tracing root is the repository root so that the workspace packages and the
 * single pnpm store are included; the server then lives at `.next/standalone/apps/web/server.js`.
 */
const standalone =
  process.env.NEXT_OUTPUT === 'standalone'
    ? { output: 'standalone' as const, outputFileTracingRoot: resolve(process.cwd(), '../..') }
    : {};

const nextConfig: NextConfig = {
  ...standalone,
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
    return [{ source: '/:path*', headers: securityHeaders() }];
  },
};

export default nextConfig;
