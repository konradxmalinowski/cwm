import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ADR 0004, ROADMAP Etap 9 kryterium 5: zaden fixture nie pochodzi z realnej konfiguracji.
 * Grep jednorazowy niczego nie pilnuje po nastepnym commicie, wiec regula jest testem.
 */

const FIXTURES = resolve(__dirname, '..', 'fixtures');

/** Katalogi, w ktorych kazdy wpis jest elementem narzedzia i musi miec nazwe `acme-*`. */
const ELEMENT_DIRS = [
  'claude-code/home/.claude/skills',
  'claude-code/home/.claude/agents',
  'claude-code/home/.claude/commands',
  'codex/home/.codex/skills',
  'codex/home/.codex/agents',
  'codex/home/.agents/skills',
];

/** Wpisy, ktore celowo nie sa elementami (korpus 12.3: plik obok agentow, ktory agentem nie jest). */
const NOT_ELEMENTS = new Set(['codex/home/.codex/agents/README.txt']);

const LEAKS: readonly { readonly rule: string; readonly pattern: RegExp }[] = [
  { rule: 'katalog domowy macOS', pattern: /\/Users\/(?!acme\b|x\/|ktos\b)[A-Za-z][\w.-]*/ },
  { rule: 'katalog domowy Linuksa', pattern: /\/home\/(?!acme\b|runner\b)[a-z][\w.-]*/ },
  { rule: 'katalog domowy Windowsa', pattern: /[A-Za-z]:\\+Users\\+(?!acme\b|runner\b)\w+/ },
  { rule: 'adres e-mail', pattern: /[\w.+-]+@[\w-]+\.[a-z]{2,}/i },
  {
    rule: 'klucz w formacie dostawcy',
    pattern: /\b(?:sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,})/,
  },
  { rule: 'blok klucza prywatnego', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

function leaksIn(text: string): string[] {
  return LEAKS.filter((l) => l.pattern.test(text)).map((l) => l.rule);
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

const rel = (path: string): string => relative(FIXTURES, path).split(sep).join('/');

describe("higiena fixture'ow (ADR 0004)", () => {
  it('kazdy element w drzewach narzedzi ma nazwe acme-*', () => {
    const offenders: string[] = [];
    for (const dir of ELEMENT_DIRS) {
      for (const name of readdirSync(join(FIXTURES, dir))) {
        const path = `${dir}/${name}`;
        if (NOT_ELEMENTS.has(path)) continue;
        if (!/^acme[- ]/i.test(name)) offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('zaden plik nie niesie sciezki domowej, adresu e-mail ani klucza', () => {
    const files = walk(FIXTURES);
    expect(files.length).toBeGreaterThan(50);
    const found = files
      .map((f) => ({ file: rel(f), rules: leaksIn(readFileSync(f).toString('latin1')) }))
      .filter((f) => f.rules.length > 0);
    expect(found).toEqual([]);
  });

  it('wykrywacz lapie przecieki (kolumna negatywna) i przepuszcza syntetyczne zapisy (pozytywna)', () => {
    for (const leak of [
      '/Users/jkowalski/.claude/skills',
      'cd /home/jan/.codex',
      'C:\\Users\\Jan\\.claude',
      'kontakt: jan.kowalski@firma.pl',
      ['s', 'k', '-', 'A'.repeat(24)].join(''),
      ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '),
    ]) {
      expect(leaksIn(leak), leak).not.toEqual([]);
    }
    for (const fine of [
      '/Users/acme/.claude',
      '/home/runner/work',
      '$HOME/acme/check.sh',
      '~/.codex/agents/acme-ghost.toml',
      'acme-fake-token-0000',
      'model = "acme-model"',
    ]) {
      expect(leaksIn(fine), fine).toEqual([]);
    }
  });
});
