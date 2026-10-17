// Enforces workspace dependency rules from docs/architecture.md §3.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Packages each workspace project must NOT import. */
export const FORBIDDEN = {
  'apps/web': ['contracts/server', 'db', 'catalog', 'courier-sdk', 'api', 'worker'],
  'apps/mobile': ['contracts/server', 'db', 'catalog', 'courier-sdk', 'api', 'worker'],
  'apps/api': ['worker'],
  'apps/worker': ['api'],
  'packages/contracts': [
    'db',
    'catalog',
    'domain',
    'courier-sdk',
    'api-client',
    'api',
    'worker',
    'web',
    'mobile',
  ],
  'packages/api-client': [
    'contracts/server',
    'db',
    'catalog',
    'domain',
    'courier-sdk',
    'api',
    'worker',
    'web',
    'mobile',
  ],
  // ui is pure presentation shared by web and mobile: it knows nothing about the business, the API, or the database.
  'packages/ui': [
    'contracts',
    'contracts/server',
    'domain',
    'api-client',
    'features',
    'db',
    'catalog',
    'courier-sdk',
    'api',
    'worker',
    'web',
    'mobile',
  ],
  // features are the cross-platform screens: built on ui, the API client, contracts and domain; never on server code or an app.
  'packages/features': [
    'contracts/server',
    'db',
    'catalog',
    'courier-sdk',
    'api',
    'worker',
    'web',
    'mobile',
  ],
  // catalog is server-side stock and import logic shared by api and worker; it sits on db and domain only.
  'packages/catalog': [
    'contracts/server',
    'api-client',
    'courier-sdk',
    'api',
    'worker',
    'web',
    'mobile',
  ],
  'packages/domain': [
    'contracts/server',
    'db',
    'catalog',
    'courier-sdk',
    'api-client',
    'api',
    'worker',
    'web',
    'mobile',
  ],
};

const IMPORT_RE =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"](@orderloop\/[\w-]+(?:\/[\w./-]+)?)/g;

export function findViolations(project, source) {
  const banned = new Set((FORBIDDEN[project] ?? []).map((n) => `@orderloop/${n}`));
  const isBanned = (spec) => [...banned].some((b) => spec === b || spec.startsWith(`${b}/`));
  return [...source.matchAll(IMPORT_RE)].map((m) => m[1]).filter(isBanned);
}

/**
 * Platform files (Foo.web.tsx, Foo.native.tsx) must never import their own base module ('./Foo'): on the web './Foo' resolves
 * to Foo.web.tsx itself, so the import is a loop that makes the bundler hang without any error. Share code through a
 * third, platform-neutral file instead.
 */
export function findSelfImports(fileName, source) {
  const m = /^(.+?)\.(web|native|ios|android)\.(tsx?|jsx?)$/.exec(fileName);
  if (!m) return [];
  const base = m[1];
  const re = new RegExp(
    `(?:from\\s+|import\\s*\\(\\s*|require\\s*\\(\\s*)['"]\\./${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:['"/])`,
    'g',
  );
  return [...source.matchAll(re)].map(() => `./${base}`);
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', '.next', '.expo', '.turbo'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) yield p;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const errors = [];
  for (const project of Object.keys(FORBIDDEN)) {
    const dir = join(root, project);
    if (!existsSync(dir)) continue;
    for (const file of walk(dir)) {
      for (const self of findSelfImports(file.split('/').pop(), readFileSync(file, 'utf8'))) {
        errors.push(
          `${relative(root, file)} imports ${self}, which resolves back to itself on that platform (infinite loop)`,
        );
      }
      for (const spec of findViolations(project, readFileSync(file, 'utf8'))) {
        errors.push(`${relative(root, file)} imports ${spec} (forbidden for ${project})`);
      }
    }
    // package.json dependencies count too
    const pj = join(dir, 'package.json');
    if (existsSync(pj)) {
      const pkg = JSON.parse(readFileSync(pj, 'utf8'));
      for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
        if (FORBIDDEN[project].some((n) => dep === `@orderloop/${n}`))
          errors.push(`${project}/package.json depends on ${dep} (forbidden)`);
      }
    }
  }
  if (errors.length) {
    console.error('Boundary violations:\n' + errors.map((e) => '  - ' + e).join('\n'));
    process.exit(1);
  }
  console.log('boundaries ok');
}
