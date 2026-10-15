// Enforces workspace dependency rules from docs/architecture.md §3.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Packages each workspace project must NOT import. */
export const FORBIDDEN = {
  'apps/web': ['db', 'courier-sdk', 'api', 'worker'],
  'apps/mobile': ['db', 'courier-sdk', 'api', 'worker'],
  'apps/api': ['worker'],
  'apps/worker': ['api'],
  'packages/contracts': ['db', 'domain', 'courier-sdk', 'api-client', 'api', 'worker', 'web', 'mobile'],
  'packages/domain': ['db', 'courier-sdk', 'api-client', 'api', 'worker', 'web', 'mobile'],
};

const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"](@orderloop\/[\w-]+)/g;

export function findViolations(project, source) {
  const banned = new Set((FORBIDDEN[project] ?? []).map((n) => `@orderloop/${n}`));
  return [...source.matchAll(IMPORT_RE)].map((m) => m[1]).filter((spec) => banned.has(spec));
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
      for (const spec of findViolations(project, readFileSync(file, 'utf8'))) {
        errors.push(`${relative(root, file)} imports ${spec} (forbidden for ${project})`);
      }
    }
    // package.json dependencies count too
    const pj = join(dir, 'package.json');
    if (existsSync(pj)) {
      const pkg = JSON.parse(readFileSync(pj, 'utf8'));
      for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
        if (FORBIDDEN[project].some((n) => dep === `@orderloop/${n}`)) errors.push(`${project}/package.json depends on ${dep} (forbidden)`);
      }
    }
  }
  if (errors.length) {
    console.error('Boundary violations:\n' + errors.map((e) => '  - ' + e).join('\n'));
    process.exit(1);
  }
  console.log('boundaries ok');
}
