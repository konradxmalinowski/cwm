import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  assertTestBaseIsSafe,
  createTempTree,
  diffFingerprints,
  isInside,
  OWNER_CONFIG_ROOTS,
  ownerFingerprint,
  removeTempTrees,
  resolveHomeDir,
} from '../harness/isolation';

const FAKE_HOME = mkdtempSync(join(tmpdir(), 'acme-home-'));

afterAll(() => {
  removeTempTrees();
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

describe('harness odmawia startu na konfiguracji wlasciciela', () => {
  for (const root of OWNER_CONFIG_ROOTS) {
    it(`odmawia, gdy katalog bazowy to ~/${root}`, () => {
      expect(() => assertTestBaseIsSafe(join(FAKE_HOME, root), FAKE_HOME)).toThrow(
        /zywej konfiguracji/,
      );
    });

    it(`odmawia, gdy katalog bazowy lezy w ~/${root}`, () => {
      expect(() =>
        assertTestBaseIsSafe(join(FAKE_HOME, root, 'skills', 'acme-demo'), FAKE_HOME),
      ).toThrow(/zywej konfiguracji/);
    });
  }

  it('odmawia, gdy katalog bazowy to katalog domowy', () => {
    expect(() => assertTestBaseIsSafe(FAKE_HOME, FAKE_HOME)).toThrow(/katalogiem domowym/);
  });

  // Kolumna pozytywna z ARCHITECTURE 12.5: nazwy mylaco podobne do zywej konfiguracji
  // i katalog tymczasowy systemu nie sa konfiguracja wlasciciela.
  for (const lookalike of [
    '.claude-backup',
    '.claude.old/skills',
    '.codex2',
    '.agents-acme',
    'acme/.claude-like',
    'projects/acme/.codex-fixtures',
  ]) {
    it(`przepuszcza katalog o mylaco podobnej nazwie: ~/${lookalike}`, () => {
      expect(() => assertTestBaseIsSafe(join(FAKE_HOME, lookalike), FAKE_HOME)).not.toThrow();
    });
  }

  it('przepuszcza katalog tymczasowy systemu', () => {
    expect(() => assertTestBaseIsSafe(join(tmpdir(), 'acme-harness'), FAKE_HOME)).not.toThrow();
  });

  it('przepuszcza katalog poza konfiguracja wlasciciela', () => {
    expect(() =>
      assertTestBaseIsSafe(join(FAKE_HOME, 'projects', 'tests'), FAKE_HOME),
    ).not.toThrow();
  });
});

describe('kanarek i drzewa tymczasowe', () => {
  it('odcisk kontrolny jest stabilny miedzy odczytami', () => {
    expect(diffFingerprints(ownerFingerprint(), ownerFingerprint())).toEqual([]);
  });

  it('wykrywa zmiane w odcisku', () => {
    expect(
      diffFingerprints({ 'file:.codex/config.toml': 'a' }, { 'file:.codex/config.toml': 'b' }),
    ).toEqual(['file:.codex/config.toml']);
  });

  it('kazde drzewo tymczasowe jest osobne i lezy w katalogu bazowym testow', () => {
    const first = createTempTree();
    const second = createTempTree();
    expect(first).not.toBe(second);
    expect(isInside(first, join(process.cwd(), 'tests', '.tmp'))).toBe(true);
  });
});

describe('rozwiazywanie katalogu domowego', () => {
  const saved = { home: process.env['HOME'], profile: process.env['USERPROFILE'] };

  afterAll(() => {
    if (saved.home === undefined) delete process.env['HOME'];
    else process.env['HOME'] = saved.home;
    if (saved.profile === undefined) delete process.env['USERPROFILE'];
    else process.env['USERPROFILE'] = saved.profile;
  });

  it('zwraca sciezke absolutna', () => {
    expect(isAbsolute(resolveHomeDir())).toBe(true);
  });

  it('bezpiecznik odmawia startu, gdy katalog domowy jest pusty, i mowi dlaczego', () => {
    expect(() => assertTestBaseIsSafe(join(FAKE_HOME, 'tests'), '')).toThrow(
      /nie udalo sie ustalic katalogu domowego/,
    );
  });

  it('komunikat o niewiedzy nie udaje komunikatu o trafieniu w konfiguracje', () => {
    let message = '';
    try {
      assertTestBaseIsSafe(join(FAKE_HOME, 'tests'), '');
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toMatch(/lezy w zywej konfiguracji/);
    expect(message).toMatch(/nie udalo sie ustalic katalogu domowego/);
  });
});
