import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ARCHITECTURE 12.4, "zakaz wykonania": zaden adapter ani core nie woła `child_process`.
 * Test statyczny obok reguly lintu (eslint.config.mjs, proba w scripts/verify-boundaries.mjs):
 * lint mozna wylaczyc komentarzem, tego testu nie.
 */

const REPO = resolve(__dirname, '..', '..');
const SCANNED = ['src/core', 'src/adapters'];

const EXEC_MODULE = String.raw`(?:node:)?(?:child_process|worker_threads|vm|cluster)`;
const FORBIDDEN: readonly { readonly rule: string; readonly pattern: RegExp }[] = [
  {
    rule: 'import modulu wykonania',
    pattern: new RegExp(String.raw`\bfrom\s+['"]${EXEC_MODULE}['"]`),
  },
  {
    rule: 'require modulu wykonania',
    pattern: new RegExp(String.raw`\brequire\s*\(\s*['"]${EXEC_MODULE}['"]`),
  },
  {
    rule: 'dynamiczny import modulu wykonania',
    pattern: new RegExp(String.raw`\bimport\s*\(\s*['"]${EXEC_MODULE}['"]`),
  },
  { rule: 'eval', pattern: /(?<![.\w])eval\s*\(/ },
  { rule: 'Function z tekstu', pattern: /\bnew\s+Function\s*\(/ },
  { rule: 'process.binding i dlopen', pattern: /\bprocess\s*\.\s*(?:binding|dlopen)\b/ },
];

function violations(source: string): string[] {
  return FORBIDDEN.filter((f) => f.pattern.test(source)).map((f) => f.rule);
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('zakaz wykonania w core/ i adapters/ (ARCHITECTURE 12.4), test statyczny', () => {
  it('zaden plik nie laduje child_process, worker_threads, vm ani cluster i nie buduje kodu z tekstu', () => {
    const files = SCANNED.flatMap((dir) => tsFiles(join(REPO, dir)));
    // Skan pustego zbioru przeszedlby zawsze: wymagamy, zeby obejmowal oba drzewa.
    expect(files.filter((f) => f.includes(`${join('src', 'adapters')}`)).length).toBeGreaterThan(
      20,
    );
    expect(files.filter((f) => f.includes(`${join('src', 'core')}`)).length).toBeGreaterThan(20);
    const found = files
      .map((f) => ({ file: relative(REPO, f), rules: violations(readFileSync(f, 'utf8')) }))
      .filter((v) => v.rules.length > 0);
    expect(found).toEqual([]);
  });

  it('wykrywacz blokuje kazda postac zaladowania (kolumna negatywna)', () => {
    const planted = [
      "import { execFile } from 'node:child_process';",
      'import * as cp from "child_process";',
      "const cp = require('child_process');",
      "const w = require ( 'node:worker_threads' );",
      "const vm = await import('node:vm');",
      "import { fork } from 'cluster';",
      'eval(code);',
      "const f = new Function('return 1');",
      "process.binding('spawn_sync');",
      'process.dlopen(module, path);',
    ];
    for (const line of planted) expect(violations(line), line).not.toEqual([]);
  });

  it('wykrywacz przepuszcza tekst, ktory tylko wspomina te nazwy (kolumna pozytywna)', () => {
    const benign = [
      "const label = 'child_process';",
      '// adapter nie uzywa child_process',
      'export type FunctionLike = () => void;',
      'const evaluate = (x: number) => x;',
      'retrieval(x);',
      "import { parse } from './vm-like';",
      'item.process.bindingName = 1;',
    ];
    for (const line of benign) expect(violations(line), line).toEqual([]);
  });
});
