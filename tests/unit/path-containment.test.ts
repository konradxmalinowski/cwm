import { win32, posix } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isPathInsideWith } from '../../src/core/model/path-containment';
import { isInsideWith } from '../harness/isolation';

/**
 * Te testy istnieja z powodu konkretnej awarii: na runnerze Windows katalog
 * roboczy `D:\a\repo` zostal uznany za lezacy w `C:\Users\runneradmin\.claude`,
 * bo `path.relative` miedzy roznymi dyskami zwraca sciezke absolutna, a nie
 * `..`. Semantyka Windowsa jest tu sprawdzana przez podstawienie `path.win32`,
 * wiec test lapie regresje takze na maszynie deweloperskiej z macOS.
 */
describe('kontrola prefiksu sciezki, semantyka Windowsa', () => {
  const rendererRoot = 'C:\\app\\dist\\renderer';

  it('sciezka na innym dysku nie lezy w katalogu docelowym', () => {
    expect(isPathInsideWith(win32, 'D:\\evil\\plik.js', rendererRoot)).toBe(false);
  });

  it('sciezka w katalogu docelowym lezy w nim', () => {
    expect(isPathInsideWith(win32, 'C:\\app\\dist\\renderer\\main.js', rendererRoot)).toBe(true);
  });

  it('wyjscie przez .. nie przechodzi', () => {
    expect(
      isPathInsideWith(win32, 'C:\\app\\dist\\renderer\\..\\..\\secret.txt', rendererRoot),
    ).toBe(false);
  });

  it('katalog rowny docelowemu tylko gdy jawnie dozwolony', () => {
    expect(isPathInsideWith(win32, rendererRoot, rendererRoot)).toBe(false);
    expect(isPathInsideWith(win32, rendererRoot, rendererRoot, { allowSame: true })).toBe(true);
  });

  it('katalog o nazwie bedacej prefiksem nie jest w srodku', () => {
    expect(isPathInsideWith(win32, 'C:\\app\\dist\\renderer-evil\\main.js', rendererRoot)).toBe(
      false,
    );
  });
});

describe('kontrola prefiksu sciezki, semantyka POSIX', () => {
  it('rozpoznaje wnetrze i zewnetrze', () => {
    expect(isPathInsideWith(posix, '/app/dist/renderer/main.js', '/app/dist/renderer')).toBe(true);
    expect(isPathInsideWith(posix, '/etc/passwd', '/app/dist/renderer')).toBe(false);
    expect(isPathInsideWith(posix, '/app/dist/renderer-evil/x', '/app/dist/renderer')).toBe(false);
  });
});

describe('nazwy zaczynajace sie od dwoch kropek leza w katalogu (nie sa wyjsciem)', () => {
  it('POSIX: ..chunk.js i ..data/x', () => {
    expect(isPathInsideWith(posix, '/app/dist/renderer/..chunk.js', '/app/dist/renderer')).toBe(
      true,
    );
    expect(isPathInsideWith(posix, '/app/dist/renderer/..data/x', '/app/dist/renderer')).toBe(true);
    expect(isPathInsideWith(posix, '/app/dist/renderer/../x', '/app/dist/renderer')).toBe(false);
  });

  it('Windows: ..chunk.js i ..data\\x', () => {
    const root = 'C:\\app\\dist\\renderer';
    expect(isPathInsideWith(win32, `${root}\\..chunk.js`, root)).toBe(true);
    expect(isPathInsideWith(win32, `${root}\\..data\\x`, root)).toBe(true);
    expect(isPathInsideWith(win32, `${root}\\..\\x`, root)).toBe(false);
    expect(isPathInsideWith(win32, 'D:\\..chunk.js', root)).toBe(false);
  });

  it('samo .. jako rodzic nadal wychodzi', () => {
    expect(isPathInsideWith(posix, '/app/dist', '/app/dist/renderer')).toBe(false);
    expect(isPathInsideWith(win32, 'C:\\app\\dist', 'C:\\app\\dist\\renderer')).toBe(false);
  });
});

describe('bezpiecznik harnessu nie blokuje obszaru roboczego CI', () => {
  const ownerClaude = 'C:\\Users\\runneradmin\\.claude';

  it('katalog roboczy na innym dysku przechodzi (awaria runnera Windows)', () => {
    expect(
      isInsideWith(
        win32,
        'D:\\a\\universal-ai-skills-manager\\universal-ai-skills-manager\\tests\\.tmp',
        ownerClaude,
      ),
    ).toBe(false);
  });

  it('katalog faktycznie w konfiguracji wlasciciela jest wykryty', () => {
    expect(isInsideWith(win32, 'C:\\Users\\runneradmin\\.claude\\skills\\acme', ownerClaude)).toBe(
      true,
    );
  });

  it('obszar roboczy Linuksa przechodzi', () => {
    expect(
      isInsideWith(posix, '/home/runner/work/repo/repo/tests/.tmp', '/home/runner/.claude'),
    ).toBe(false);
  });

  it('katalog w konfiguracji wlasciciela na POSIX jest wykryty', () => {
    expect(isInsideWith(posix, '/home/runner/.claude/skills/acme', '/home/runner/.claude')).toBe(
      true,
    );
  });
});
