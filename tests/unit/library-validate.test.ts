import { describe, expect, it } from 'vitest';

import type { ItemId } from '../../src/core/model/item';
import { LibraryValidationError } from '../../src/core/model/library-errors';
import { sha256Text } from '../../src/core/services/normalization/hash';
import {
  checkAssetPath,
  findSlugCollision,
  parseItemMeta,
  slugDeclaredNameWarning,
  validateAssetPaths,
  validateSlug,
} from '../../src/core/services/library/validate';

describe('slug: reguly bezpieczne na trzech systemach', () => {
  it.each(['acme-review', 'Acme-Review', 'acme_review.v2', 'a', '9lives', 'acme.review'])(
    'przepuszcza %s',
    (slug) => {
      expect(validateSlug(slug)).toBeNull();
    },
  );

  it.each([
    ['', 'slug-invalid'],
    ['-acme', 'slug-invalid'],
    ['.acme', 'slug-invalid'],
    ['acme.', 'slug-invalid'],
    ['acme review', 'slug-invalid'],
    ['acme/review', 'slug-invalid'],
    ['acme\\review', 'slug-invalid'],
    ['acme:review', 'slug-invalid'],
    ['zażółć', 'slug-invalid'],
    ['a'.repeat(65), 'slug-invalid'],
    ['con', 'slug-reserved'],
    ['AUX', 'slug-reserved'],
    ['nul.txt', 'slug-reserved'],
    ['com1', 'slug-reserved'],
    ['LPT9', 'slug-reserved'],
  ])('odrzuca %j jako %s', (slug, reason) => {
    expect(validateSlug(slug)?.reason).toBe(reason);
  });

  it('slug zawierajacy nazwe zarezerwowana jako fragment przechodzi', () => {
    expect(validateSlug('console-tools')).toBeNull();
    expect(validateSlug('aux-helper')).toBeNull();
    expect(validateSlug('com10')).toBeNull();
  });

  it('nie-tekst jest odrzucony', () => {
    expect(validateSlug(undefined)?.reason).toBe('slug-invalid');
    expect(validateSlug(42)?.reason).toBe('slug-invalid');
  });
});

describe('kolizja lower(slug) + kind (ADR 0017)', () => {
  const existing = [{ id: 'A' as ItemId, kind: 'skill' as const, slug: 'acme-review' }];

  it('blokuje ten sam slug w innej wielkosci liter tego samego typu', () => {
    const problem = findSlugCollision({ kind: 'skill', slug: 'Acme-Review' }, existing);
    expect(problem?.reason).toBe('slug-collision');
    expect(problem?.message).toContain('wielkością liter');
    expect(problem?.detail?.conflictsWith).toBe('A');
  });

  it('blokuje identyczny slug z komunikatem bez wzmianki o wielkosci liter', () => {
    const problem = findSlugCollision({ kind: 'skill', slug: 'acme-review' }, existing);
    expect(problem?.reason).toBe('slug-collision');
    expect(problem?.message).not.toContain('wielkością liter');
  });

  it('ten sam slug innego typu przechodzi', () => {
    expect(findSlugCollision({ kind: 'agent', slug: 'acme-review' }, existing)).toBeNull();
  });

  it('element nie koliduje sam ze soba', () => {
    expect(
      findSlugCollision({ kind: 'skill', slug: 'ACME-REVIEW', self: 'A' as ItemId }, existing),
    ).toBeNull();
  });

  it('inny slug przechodzi', () => {
    expect(findSlugCollision({ kind: 'skill', slug: 'acme-deploy' }, existing)).toBeNull();
  });
});

describe('rozjechanie slug i declaredName (ADR 0026)', () => {
  it('jest ostrzezeniem, nie bledem', () => {
    const warning = slugDeclaredNameWarning({
      slug: 'acme-review',
      declaredName: 'acme-code-review',
    });
    expect(warning?.code).toBe('slug-differs-from-declared-name');
  });

  it('zgodne nazwy i brak declaredName nie ostrzegaja', () => {
    expect(slugDeclaredNameWarning({ slug: 'acme', declaredName: 'acme' })).toBeNull();
    expect(slugDeclaredNameWarning({ slug: 'acme', declaredName: null })).toBeNull();
  });
});

describe('sciezki assetow: test negatywny', () => {
  it.each([
    ['', 'asset-path-empty'],
    ['../secret.txt', 'asset-path-traversal'],
    ['docs/../../secret.txt', 'asset-path-traversal'],
    ['docs/./notes.md', 'asset-path-traversal'],
    ['/etc/passwd', 'asset-path-absolute'],
    ['C:/Windows/notes.txt', 'asset-path-absolute'],
    ['docs\\notes.md', 'asset-path-backslash'],
    ['\\\\server\\share\\a.txt', 'asset-path-backslash'],
    ['docs//notes.md', 'asset-path-empty-segment'],
    ['docs/', 'asset-path-empty-segment'],
    ['notes\u0000.md', 'asset-path-control-char'],
    ['notes\n.md', 'asset-path-control-char'],
    ['notes\u007f.md', 'asset-path-control-char'],
    ['notes.', 'asset-path-trailing-dot-or-space'],
    ['docs /notes.md', 'asset-path-trailing-dot-or-space'],
    ['notes.md ', 'asset-path-trailing-dot-or-space'],
    ['con', 'asset-path-reserved-name'],
    ['aux.txt', 'asset-path-reserved-name'],
    ['docs/NUL.md', 'asset-path-reserved-name'],
    ['docs/Com1.tar.gz', 'asset-path-reserved-name'],
    ['lpt\u00b9.txt', 'asset-path-reserved-name'],
    ['conin$', 'asset-path-reserved-name'],
    ['refs/.x.md.4242.0a1b2c3d4e5f.tmp', 'asset-path-temp-name'],
    ['.x.md.4242.0a1b2c3d4e5f.tmp/inner.md', 'asset-path-temp-name'],
    ['refs/.DS_Store', 'asset-path-junk-name'],
    ['Thumbs.db', 'asset-path-junk-name'],
    ['a/THUMBS.DB', 'asset-path-junk-name'],
    ['desktop.INI', 'asset-path-junk-name'],
    ['a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/deep.txt', 'asset-path-too-long'],
    ['notes:stream', 'asset-path-forbidden-char'],
    ['what?.md', 'asset-path-forbidden-char'],
    ['a|b.md', 'asset-path-forbidden-char'],
    ['x'.repeat(121), 'asset-path-too-long'],
    [`${'x'.repeat(60)}/${'y'.repeat(60)}`, 'asset-path-too-long'],
    [`${'x'.repeat(256)}.md`, 'asset-path-too-long'],
  ])('odrzuca %j jako %s', (path, reason) => {
    expect(checkAssetPath(path)?.reason).toBe(reason);
  });
});

describe('sciezki assetow: test pozytywny', () => {
  it.each([
    'notes.md',
    'x'.repeat(120),
    `${'x'.repeat(59)}/${'y'.repeat(60)}`,
    'my notes/read me.md',
    'dokumentacja/zażółć gęślą jaźń.md',
    '日本語/メモ.md',
    'a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/deep.txt',
    'LICENSE',
    'scripts/run',
    '.hidden/.config',
    'consolidated.md',
    'aux-notes.md',
    'com10.txt',
    'notes..md',
    'v1.2.3/file',
    'notes.tmp',
    'refs/.hidden.tmp',
    '.a.tmp',
    '.x.md.abc.123456.tmp',
    'notes.tmp/inner.md',
    '.DS_Store.md',
    'refs/thumbs.db.bak',
    'desktop.ini.txt',
  ])('przepuszcza %j', (path) => {
    expect(checkAssetPath(path)).toBeNull();
  });
});

describe('zbior sciezek assetow jednego elementu', () => {
  it('normalizuje NFD do NFC', () => {
    const nfd = 'zo\u0301ła.md';
    const result = validateAssetPaths([nfd]);
    expect(result.issues).toEqual([]);
    expect(result.paths).toEqual(['z\u00f3ła.md']);
    expect(result.paths[0]).not.toBe(nfd);
  });

  it('NFD i NFC tej samej nazwy to kolizja', () => {
    const result = validateAssetPaths(['\u00f3.md', 'o\u0301.md']);
    expect(result.issues.map((i) => i.reason)).toEqual(['asset-path-collision']);
  });

  it('nazwy roznia sie tylko wielkoscia liter: kolizja', () => {
    const result = validateAssetPaths(['Docs/Readme.md', 'docs/README.md']);
    expect(result.issues.map((i) => i.reason)).toEqual(['asset-path-collision']);
  });

  it('ta sama sciezka dwa razy: kolizja', () => {
    const result = validateAssetPaths(['a.md', 'a.md']);
    expect(result.issues[0]?.reason).toBe('asset-path-collision');
  });

  it('plik i katalog o tej samej nazwie: konflikt', () => {
    const result = validateAssetPaths(['docs', 'docs/readme.md']);
    expect(result.issues.map((i) => i.reason)).toEqual(['asset-path-file-dir-conflict']);
  });

  it('rozne nazwy w jednym katalogu i katalogi o wspolnym prefiksie przechodza', () => {
    const result = validateAssetPaths(['docs/a.md', 'docs/b.md', 'docs2/a.md', 'doc/a.md']);
    expect(result.issues).toEqual([]);
  });

  it('pierwszy niepoprawny wpis zatrzymuje sprawdzanie kolizji', () => {
    const result = validateAssetPaths(['../x', 'a.md']);
    expect(result.issues.map((i) => i.reason)).toEqual(['asset-path-traversal']);
  });
});

describe('niezaufany item.json z dysku', () => {
  const ID = '01JAAAAAAAAAAAAAAAAAAAAAAA';

  function valid(): Record<string, unknown> {
    return {
      formatVersion: 1,
      id: ID,
      kind: 'skill',
      identity: { slug: 'acme-review', declaredName: null, aliases: [] },
      content: { title: 'Acme', description: 'opis', descriptionOrigin: 'source' },
      attributes: {},
      assets: [],
      source: { snapshots: [], importedFrom: null },
      classification: { scope: 'private', secretFindings: [] },
      version: {
        revision: 1,
        contentHash: sha256Text(''),
        updatedAt: '2026-10-30T12:00:00.000Z',
      },
    };
  }

  function reasonOf(raw: unknown, expectedId = ID): string {
    try {
      parseItemMeta(raw, expectedId, 'disk');
    } catch (error: unknown) {
      if (error instanceof LibraryValidationError) return error.reason;
      throw error;
    }
    return 'ok';
  }

  it('poprawny obiekt przechodzi', () => {
    expect(reasonOf(valid())).toBe('ok');
  });

  it('nieobslugiwana wersja formatu', () => {
    expect(reasonOf({ ...valid(), formatVersion: 2 })).toBe('unsupported-format');
    const without = valid();
    delete without['formatVersion'];
    expect(reasonOf(without)).toBe('unsupported-format');
  });

  it('id niezgodny z nazwa katalogu', () => {
    expect(reasonOf(valid(), '01JBBBBBBBBBBBBBBBBBBBBBBB')).toBe('id-mismatch');
  });

  it('nieznany kind', () => {
    expect(reasonOf({ ...valid(), kind: 'plugin' })).toBe('unknown-kind');
  });

  it.each([null, 'tekst', 42, [], undefined])('zly ksztalt korzenia: %j', (raw) => {
    expect(reasonOf(raw)).toBe('item-shape-invalid');
  });

  it.each(['identity', 'content', 'attributes', 'assets', 'source', 'classification', 'version'])(
    'brak sekcji %s',
    (key) => {
      const raw = valid();
      delete raw[key];
      expect(reasonOf(raw)).toBe('item-shape-invalid');
    },
  );

  it('slug z dysku podlega tym samym regulom co przy zapisie', () => {
    const raw = valid();
    raw['identity'] = { slug: '../evil', declaredName: null, aliases: [] };
    expect(reasonOf(raw)).toBe('slug-invalid');
  });

  it('sciezka assetu z dysku podlega walidacji', () => {
    const raw = valid();
    raw['assets'] = [{ relPath: '../x', bytesHash: sha256Text('x'), sizeBytes: 1 }];
    expect(reasonOf(raw)).toBe('asset-path-traversal');
  });

  it('sciezka assetu w NFD jest odrzucona, bo zapis zawsze produkuje NFC', () => {
    const raw = valid();
    raw['assets'] = [{ relPath: 'o\u0301.md', bytesHash: sha256Text('x'), sizeBytes: 1 }];
    expect(reasonOf(raw)).toBe('item-shape-invalid');
  });

  it('zly hash, ujemny rozmiar, zla rewizja, zla data', () => {
    const base = valid();
    expect(reasonOf({ ...base, assets: [{ relPath: 'a', bytesHash: 'xyz', sizeBytes: 1 }] })).toBe(
      'item-shape-invalid',
    );
    expect(
      reasonOf({ ...base, assets: [{ relPath: 'a', bytesHash: sha256Text('a'), sizeBytes: -1 }] }),
    ).toBe('item-shape-invalid');
    expect(reasonOf({ ...base, version: { ...(base['version'] as object), revision: 0 } })).toBe(
      'item-shape-invalid',
    );
    expect(
      reasonOf({ ...base, version: { ...(base['version'] as object), updatedAt: 'wczoraj' } }),
    ).toBe('item-shape-invalid');
  });

  it('zly scope i zly descriptionOrigin', () => {
    const base = valid();
    expect(reasonOf({ ...base, classification: { scope: 'world', secretFindings: [] } })).toBe(
      'item-shape-invalid',
    );
    expect(
      reasonOf({ ...base, content: { title: 'a', description: '', descriptionOrigin: 'guess' } }),
    ).toBe('item-shape-invalid');
  });

  it('niepoprawny hook jest odrzucony, poprawny przechodzi', () => {
    const hook = {
      event: 'PreToolUse',
      matcher: null,
      command: 'echo ok',
      pathStyle: 'absolute',
      timeoutSeconds: 10,
    };
    expect(reasonOf({ ...valid(), attributes: { hook } })).toBe('ok');
    expect(reasonOf({ ...valid(), attributes: { hook: { ...hook, pathStyle: 'weird' } } })).toBe(
      'item-shape-invalid',
    );
    expect(reasonOf({ ...valid(), attributes: { hook: { ...hook, command: '' } } })).toBe(
      'item-shape-invalid',
    );
  });

  it('dwa snapshoty tego samego narzedzia sa odrzucone', () => {
    const snapshot = { tool: 'codex', files: [], unmappedKeys: [] };
    expect(
      reasonOf({ ...valid(), source: { snapshots: [snapshot, snapshot], importedFrom: null } }),
    ).toBe('item-shape-invalid');
  });

  it('klucz __proto__ w unmappedKeys nie zmienia prototypu', () => {
    const snapshot = {
      tool: 'codex',
      files: [],
      unmappedKeys: [
        { path: 'x', value: JSON.parse('{"__proto__": {"polluted": true}}') as unknown },
      ],
    };
    const meta = parseItemMeta(
      { ...valid(), source: { snapshots: [snapshot], importedFrom: null } },
      ID,
      'disk',
    );
    const value = meta.source.snapshots[0]?.unmappedKeys[0]?.value as object;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('kontekst draft zglasza field-invalid zamiast item-shape-invalid', () => {
    expect(() => parseItemMeta({ ...valid(), kind: 'skill', content: null }, ID, 'draft')).toThrow(
      expect.objectContaining({ reason: 'field-invalid' }) as Error,
    );
  });
});
