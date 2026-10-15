import type { NextConfig } from 'next';
import { resolve } from 'node:path';

// Next only reads .env from apps/web; the repo keeps a single root .env.
try {
  process.loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // No root .env (e.g. CI injects variables directly).
}

const nextConfig: NextConfig = {
  turbopack: {
    rules: {
      '*.css': { loaders: ['@tailwindcss/turbopack'], as: '*.css' },
    },
  },
};

export default nextConfig;
