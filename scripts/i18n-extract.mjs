// Lists the English text people read in the shared UI (packages/ui, packages/features, apps/mobile): the keys of the
// Bangla catalogues. Usage: node scripts/i18n-extract.mjs [--json] ; template literals come out with {name} placeholders.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const ts = require(require.resolve('typescript', { paths: [resolve('packages/ui')] }));
const ROOTS = ['packages/ui/src', 'packages/features/src', 'apps/mobile/src'];
const found = new Map(); // text -> Set(files)

const TEXT_PROPS = new Set([
  'label',
  'title',
  'description',
  'placeholder',
  'hint',
  'header',
  'summary',
  'message',
  'text',
  'accessibilityLabel',
  'aria-label',
  'what',
  'submitLabel',
  'confirmLabel',
  'emptyText',
  'name',
  'subtitle',
  'caption',
  'heading',
  'help',
  'body',
  'actionLabel',
  'cancelLabel',
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (
      /\.(tsx?|jsx?)$/.test(name) &&
      !/\.(test|spec)\./.test(name) &&
      !name.endsWith('.d.ts')
    )
      out.push(p);
  }
  return out;
}

const looksLikeText = (s) =>
  s.length >= 2 &&
  s.length <= 240 &&
  /[A-Za-z]/.test(s) &&
  /[a-z]/.test(s) &&
  !/^[a-z][A-Za-z0-9]*$/.test(s) &&
  !/^[#./@:]|\/\/|^[a-z]+_[a-z_]+$|^\w+-\w+(-\w+)*$/.test(s) &&
  !/^(https?|rgb|var)\b/.test(s);

function add(text, file) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!looksLikeText(t)) return;
  if (!found.has(t)) found.set(t, new Set());
  found.get(t).add(file);
}

function literalText(node, sf) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const raw = span.expression.getText(sf);
      const name =
        raw
          .replace(/[^A-Za-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 24) || 'value';
      out += `{${name}}` + span.literal.text;
    }
    return out;
  }
  return null;
}

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const sf = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const rel = relative('.', file);
    const visit = (node) => {
      if (ts.isJsxText(node)) add(node.text, rel);
      else if (
        ts.isJsxAttribute(node) &&
        node.initializer &&
        TEXT_PROPS.has(node.name.getText(sf))
      ) {
        const init = ts.isJsxExpression(node.initializer)
          ? node.initializer.expression
          : node.initializer;
        const t = init && literalText(init, sf);
        if (t) add(t, rel);
      } else if (ts.isJsxExpression(node) && node.expression && ts.isJsxElement(node.parent)) {
        const e = node.expression;
        const t = literalText(e, sf);
        if (t) add(t, rel);
        // {cond ? 'a' : 'b'} and {x && 'text'}
        if (ts.isConditionalExpression(e))
          for (const b of [e.whenTrue, e.whenFalse]) {
            const v = literalText(b, sf);
            if (v) add(v, rel);
          }
        if (ts.isBinaryExpression(e)) {
          const v = literalText(e.right, sf);
          if (v) add(v, rel);
        }
      } else if (ts.isPropertyAssignment(node)) {
        const key = node.name.getText(sf).replace(/['"]/g, '');
        const t = literalText(node.initializer, sf);
        if (t && (TEXT_PROPS.has(key) || /^[A-Z]/.test(t))) add(t, rel);
      } else if (
        ts.isCallExpression(node) &&
        /\b(success|error|info|warning)$/.test(node.expression.getText(sf))
      ) {
        for (const a of node.arguments) {
          const t = literalText(a, sf);
          if (t) add(t, rel);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}

const list = [...found.entries()].sort((a, b) => a[0].localeCompare(b[0]));
if (process.argv.includes('--json'))
  console.log(
    JSON.stringify(Object.fromEntries(list.map(([k, v]) => [k, [...v].slice(0, 2)])), null, 1),
  );
else for (const [k, v] of list) console.log(k, '\t', [...v][0]);
console.error(`${list.length} strings`);
