import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { AssetInput, ItemDraft, Sha256 } from '../../src/core/model/item';
import { LibraryError, type LibraryOperationError } from '../../src/core/model/library-errors';
import { createUlidGenerator } from '../../src/core/ports/id-generator';
import { LibraryService } from '../../src/core/services/library/library-service';
import { sha256Text } from '../../src/core/services/normalization/hash';
import { FsLibraryStore } from '../../src/infra/library/library-store';
import { FsObjectStore } from '../../src/infra/store/object-store';
import { createTempTree, removeTempTrees } from '../harness/isolation';
import {
  FakeClock,
  MemoryOperationLog,
  bytes,
  deterministicRandom,
  draft,
} from '../unit/library-fakes';

afterAll(() => {
  removeTempTrees();
});

// Uprawnienia katalogow to pojecie POSIX (ADR 0018), a root je omija, wiec test nic by nie dowodzil.
const posixNonRoot = it.skipIf(process.platform === 'win32' || process.getuid?.() === 0);

function setup() {
  const root = createTempTree('acme-accept-');
  const clock = new FakeClock();
  const log = new MemoryOperationLog();
  const objectsDir = join(root, 'objects');
  const libraryDir = join(root, 'library');
  const objects = new FsObjectStore(objectsDir);
  const service = new LibraryService({
    store: new FsLibraryStore(libraryDir),
    objects,
    log,
    ids: createUlidGenerator(clock, deterministicRandom()),
    clock,
  });
  const itemDir = (id: string) => join(libraryDir, 'items', id);
  const itemsDir = join(libraryDir, 'items');
  return { root, clock, log, objects, objectsDir, itemsDir, service, itemDir };
}

/** Pliki pod `dir` jako sciezka z `/` -> bajty. Brak katalogu to puste drzewo. */
function snapshot(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const abs = join(entry.parentPath, entry.name);
    out.set(relative(dir, abs).split('\\').join('/'), readFileSync(abs));
  }
  return out;
}

async function failureOf(promise: Promise<unknown>): Promise<LibraryError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof LibraryError) return error;
    throw error;
  }
  throw new Error('operacja przeszla, a miala zostac odrzucona');
}

const asset = (relPath: string, content: string): AssetInput => ({
  relPath,
  bytes: bytes(content),
});

describe('kryterium 8 na dysku: kolizja lower(slug) + kind', () => {
  it('Acme-Review po acme-review tego samego typu: komunikat walidatora, bez drugiego katalogu i obiektu', async () => {
    const { service, itemsDir, objectsDir, root } = setup();
    const { item } = await service.create(draft({ slug: 'acme-review' }));
    const objectsBefore = snapshot(objectsDir);

    const error = await failureOf(service.create(draft({ slug: 'Acme-Review' })));

    expect(error.name).toBe('LibraryValidationError');
    expect(error.reason).toBe('slug-collision');
    expect(error).toMatchObject({ detail: { conflictsWith: item.id } });
    expect(error.message).toContain('"acme-review"');
    expect(error.message).toContain('"Acme-Review"');
    expect(error.message).toContain('wielkością liter');
    expect(error.message).not.toContain(root);
    expect(readdirSync(itemsDir)).toEqual([item.id]);
    expect(snapshot(objectsDir)).toEqual(objectsBefore);
  });

  it('ten sam slug innego typu przechodzi i lezy obok', async () => {
    const { service, itemsDir } = setup();
    const skill = await service.create(draft({ slug: 'acme-review' }));
    const agent = await service.create({ ...draft({ slug: 'Acme-Review' }), kind: 'agent' });

    expect(readdirSync(itemsDir).sort()).toEqual([skill.item.id, agent.item.id].sort());
    expect((await service.get(agent.item.id)).item.identity.slug).toBe('Acme-Review');
  });

  it('update bez zmiany sluga nie koliduje sam ze soba', async () => {
    const { service, clock } = setup();
    const { item } = await service.create(draft({ slug: 'acme-review', body: 'v1\n' }));
    clock.advance(1000);

    const updated = await service.update(item.id, draft({ slug: 'acme-review', body: 'v2\n' }));
    expect(updated.item.version.revision).toBe(2);
    expect((await service.get(item.id)).item.content.body).toBe('v2\n');
  });

  it('element niespojny (body.md zmieniony poza aplikacja) nadal blokuje swoj slug', async () => {
    const { service, itemDir, itemsDir } = setup();
    const { item } = await service.create(draft({ slug: 'acme-review' }));
    writeFileSync(join(itemDir(item.id), 'body.md'), 'zmienione w edytorze\n');
    expect((await service.list()).inconsistent.map((i) => i.id)).toEqual([item.id]);

    const error = await failureOf(service.create(draft({ slug: 'ACME-REVIEW' })));
    expect(error.reason).toBe('slug-collision');
    expect(readdirSync(itemsDir)).toEqual([item.id]);
  });
});

describe('A2 na dysku: bez kopii poprzedniej wersji w objects/ nie ma nadpisania', () => {
  // Obiekty usuniete przed odebraniem uprawnien: inaczej poprzednia wersja juz tam lezy
  // od zapisu w create, put jest idempotentny i do zapisu poprzedniej wersji w ogole nie dochodzi.
  posixNonRoot(
    'objects/ tylko do odczytu: update odrzucony z przyczyna, element bajt w bajt nietkniety; po naprawie przechodzi',
    async () => {
      const { service, objects, objectsDir, itemDir, log, clock } = setup();
      const { item } = await service.create(
        draft({ body: 'v1\n', assets: [asset('refs/a.md', 'A1')] }),
      );
      rmSync(objectsDir, { recursive: true });
      mkdirSync(objectsDir, { mode: 0o500 });
      const before = snapshot(itemDir(item.id));
      const logBefore = log.records.length;

      try {
        clock.advance(1000);
        const error = await failureOf(
          service.update(item.id, draft({ body: 'v2\n', assets: [asset('refs/a.md', 'A2')] })),
        );
        expect(error.reason).toBe('backup-failed');
        expect(error.cause).toMatchObject({
          name: 'AtomicWriteError',
          reason: 'permission-denied',
        });
        expect(snapshot(itemDir(item.id))).toEqual(before);
        expect(readdirSync(objectsDir)).toEqual([]);
        expect(log.records).toHaveLength(logBefore);
      } finally {
        chmodSync(objectsDir, 0o700);
      }

      const updated = await service.update(
        item.id,
        draft({ body: 'v2\n', assets: [asset('refs/a.md', 'A2')] }),
      );
      expect(updated.item.version.revision).toBe(2);
      const previous = log.records.at(-1)?.before;
      expect(previous?.revision).toBe(1);
      const record = await objects.get(previous?.versionHash as Sha256);
      expect(JSON.parse(Buffer.from(record ?? []).toString('utf8'))).toMatchObject({
        content: { body: 'v1\n' },
      });
      expect(readFileSync(join(itemDir(item.id), 'body.md'), 'utf8')).toBe('v2\n');
    },
  );

  posixNonRoot(
    'objects/ tylko do odczytu z poprzednia wersja w srodku: nowej wersji nie da sie zarchiwizowac, wiec tez bez zapisu',
    async () => {
      const { service, objectsDir, itemDir, clock } = setup();
      const { item } = await service.create(draft({ body: 'v1\n' }));
      const before = snapshot(itemDir(item.id));
      chmodSync(objectsDir, 0o500);

      try {
        clock.advance(1000);
        const error = await failureOf(service.update(item.id, draft({ body: 'v2\n' })));
        expect(error.reason).toBe('backup-failed');
        expect(snapshot(itemDir(item.id))).toEqual(before);
      } finally {
        chmodSync(objectsDir, 0o700);
      }
    },
  );
});

describe('A3 na dysku: usuniecie przez plan', () => {
  it('reczna zmiana body.md miedzy planem a apply: plan przeterminowany, nic nie znika', async () => {
    const { service, itemDir } = setup();
    const { item } = await service.create(draft({ body: 'v1\n' }));
    const plan = await service.planDelete(item.id);
    expect(plan.applicable).toBe(true);

    writeFileSync(join(itemDir(item.id), 'body.md'), 'dopisane w edytorze\n');
    const error = await failureOf(service.applyDelete(plan));

    expect(error.reason).toBe('stale-plan');
    expect(readFileSync(join(itemDir(item.id), 'body.md'), 'utf8')).toBe('dopisane w edytorze\n');
    expect(existsSync(join(itemDir(item.id), 'item.json'))).toBe(true);
  });

  it('plan bez zmian usuwa katalog, a tresc i assety da sie odczytac z objects/', async () => {
    const { service, objects, itemDir, log } = setup();
    const { item } = await service.create(
      draft({ body: 'do usuniecia\n', assets: [asset('zalacznik.txt', 'bajty zalacznika')] }),
    );

    await service.applyDelete(await service.planDelete(item.id));

    expect(existsSync(itemDir(item.id))).toBe(false);
    const deleted = log.records.at(-1);
    expect(deleted?.operation).toBe('delete');
    const record = await objects.get(deleted?.before?.versionHash as Sha256);
    const parsed = JSON.parse(Buffer.from(record ?? []).toString('utf8')) as {
      content: { body: string };
      assets: { relPath: string; bytesHash: Sha256 }[];
    };
    expect(parsed.content.body).toBe('do usuniecia\n');
    const assetHash = parsed.assets.find((a) => a.relPath === 'zalacznik.txt')?.bytesHash;
    const assetBytes = await objects.get(assetHash as Sha256);
    expect(Buffer.from(assetBytes ?? []).toString('utf8')).toBe('bajty zalacznika');
  });
});

describe('A4 na dysku: LF i CRLF', () => {
  it('ten sam element w LF i CRLF ma identyczny contentHash i identyczne bajty body.md', async () => {
    const { service, itemDir } = setup();
    const lf = await service.create(draft({ slug: 'acme-lf', body: '# Acme\n\nlinia\n' }));
    const crlf = await service.create(
      draft({ slug: 'acme-crlf', body: '# Acme\r\n\r\nlinia\r\n' }),
    );

    expect(crlf.item.version.contentHash).toBe(lf.item.version.contentHash);
    expect(lf.item.version.contentHash).toBe(sha256Text('# Acme\n\nlinia\n'));
    const lfBytes = readFileSync(join(itemDir(lf.item.id), 'body.md'));
    const crlfBytes = readFileSync(join(itemDir(crlf.item.id), 'body.md'));
    expect(crlfBytes).toEqual(lfBytes);
    expect(crlfBytes.includes(0x0d)).toBe(false);
  });

  it('body.md przepisany na CRLF poza aplikacja (autocrlf) czyta sie jako spojny element', async () => {
    const { service, itemDir } = setup();
    const { item } = await service.create(draft({ body: 'a\nb\n' }));
    writeFileSync(join(itemDir(item.id), 'body.md'), 'a\r\nb\r\n');

    const list = await service.list();
    expect(list.inconsistent).toEqual([]);
    expect(list.problems).toEqual([]);
    expect((await service.get(item.id)).item.content.body).toBe('a\nb\n');
  });
});

describe('A5 na dysku: sciezki assetow przez caly stos', () => {
  const nfc = 'zażółć.md';
  const rejected: readonly [string, readonly string[], string][] = [
    ['..', ['../acme.txt'], 'asset-path-traversal'],
    ['sciezka absolutna', ['/tmp/acme.txt'], 'asset-path-absolute'],
    ['dysk Windows z ukosnikiem wstecznym', ['C:\\acme.txt'], 'asset-path-backslash'],
    ['dysk Windows bez ukosnika', ['C:acme.txt'], 'asset-path-absolute'],
    ['ukosnik wsteczny na POSIX', ['docs\\acme.md'], 'asset-path-backslash'],
    ['CON', ['CON'], 'asset-path-reserved-name'],
    ['aux.txt', ['aux.txt'], 'asset-path-reserved-name'],
    ['com1.md', ['docs/com1.md'], 'asset-path-reserved-name'],
    ['NUL w nazwie', ['acme\u0000.md'], 'asset-path-control-char'],
    ['znak sterujacy', ['acme\u0007.md'], 'asset-path-control-char'],
    ['koncowa kropka', ['acme.'], 'asset-path-trailing-dot-or-space'],
    ['koncowa spacja', ['acme.md '], 'asset-path-trailing-dot-or-space'],
    ['NFD i NFC tej samej nazwy', [nfc, nfc.normalize('NFD')], 'asset-path-collision'],
    [
      'dwa assety rozne tylko wielkoscia liter',
      ['Docs/Acme.md', 'docs/acme.md'],
      'asset-path-collision',
    ],
  ];

  for (const [label, paths, reason] of rejected) {
    it(`odrzuca: ${label} (${reason}), zanim cokolwiek trafi na dysk`, async () => {
      const { service, root } = setup();
      const before = snapshot(root);

      const error = await failureOf(
        service.create(draft({ assets: paths.map((p) => asset(p, 'acme')) })),
      );

      expect(error.reason).toBe(reason);
      expect(snapshot(root)).toEqual(before);
      expect(readdirSync(root)).toEqual([]);
    });
  }

  it('przepuszcza nazwy bezpieczne i zapisuje je pod tymi samymi sciezkami na dysku', async () => {
    const { service, itemDir } = setup();
    const accepted = [
      'acme notes/read me.md',
      nfc,
      '資料/説明.md',
      'p1/p2/p3/p4/p5/p6/p7/p8/p9/p10/acme.txt',
      'Makefile',
      'acme-console.md',
      'icon.svg',
    ];

    const { item } = await service.create(
      draft({ assets: accepted.map((p) => asset(p, `tresc ${p}`)) }),
    );
    const loaded = await service.get(item.id);

    for (const path of accepted) {
      expect(readFileSync(join(itemDir(item.id), 'assets', ...path.split('/')), 'utf8')).toBe(
        `tresc ${path}`,
      );
      expect(
        Buffer.from(loaded.assets.find((a) => a.relPath === path)?.bytes ?? []).toString('utf8'),
      ).toBe(`tresc ${path}`);
    }
  });

  it('nazwa podana w NFD trafia na dysk w NFC', async () => {
    const { service, itemDir } = setup();
    const { item } = await service.create(draft({ assets: [asset(nfc.normalize('NFD'), 'x')] }));

    expect(item.assets.map((a) => a.relPath)).toEqual([nfc]);
    expect(readdirSync(join(itemDir(item.id), 'assets'))).toEqual([nfc]);
  });
});

describe('A5 na dysku: niezaufany item.json', () => {
  async function created() {
    const ctx = setup();
    const { item } = await ctx.service.create(
      draft({ body: 'tresc\n', assets: [asset('refs/a.md', 'A')] }),
    );
    const path = join(ctx.itemDir(item.id), 'item.json');
    const json = () => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return { ...ctx, item, path, json };
  }

  const corruptions: readonly [string, (raw: Record<string, unknown>) => string, string][] = [
    ['zly JSON', () => '{ "formatVersion": 1, ', 'item-json-malformed'],
    ['pusty plik', () => '', 'item-json-malformed'],
    ['nieznany kind', (raw) => JSON.stringify({ ...raw, kind: 'acme-widget' }), 'unknown-kind'],
    [
      'brakujace pole',
      (raw) => JSON.stringify({ ...raw, content: undefined }),
      'item-shape-invalid',
    ],
    [
      'sciezka assetu wychodzaca poza element',
      (raw) =>
        JSON.stringify({
          ...raw,
          assets: [{ relPath: '../../acme-outside.txt', bytesHash: '0'.repeat(64), sizeBytes: 1 }],
        }),
      'asset-path-traversal',
    ],
  ];

  for (const [label, corrupt, reason] of corruptions) {
    it(`odrzuca: ${label} (${reason}); list() raportuje problem i pokazuje pozostale`, async () => {
      const { service, item, path, json } = await created();
      const healthy = await service.create(draft({ slug: 'acme-healthy' }));
      writeFileSync(path, corrupt(json()));

      expect((await failureOf(service.get(item.id))).reason).toBe(reason);
      const list = await service.list();
      expect(list.problems).toEqual([expect.objectContaining({ id: item.id, reason })]);
      expect(list.items.map((i) => i.id)).toEqual([healthy.item.id]);
    });
  }

  it('odrzuca item.json innego elementu pod obca nazwa katalogu (id-mismatch)', async () => {
    const { service, itemDir, item } = await created();
    const other = await service.create(draft({ slug: 'acme-other' }));
    writeFileSync(
      join(itemDir(other.item.id), 'item.json'),
      readFileSync(join(itemDir(item.id), 'item.json')),
    );

    expect((await failureOf(service.get(other.item.id))).reason).toBe('id-mismatch');
  });

  it('przepuszcza item.json przepisany przez edytor: BOM, CRLF, inne wciecia i kolejnosc kluczy', async () => {
    const { service, item, path, json } = await created();
    const raw = json();
    const reordered = Object.fromEntries(Object.entries(raw).reverse());
    writeFileSync(path, `\uFEFF${JSON.stringify(reordered, null, 4).split('\n').join('\r\n')}\r\n`);

    const loaded = await service.get(item.id);
    expect(loaded.item).toEqual(item);
    expect((await service.list()).problems).toEqual([]);
  });
});

describe('A5 na dysku: zapis atomowy pod biblioteka', () => {
  // Zamiana elementu to rename w items/, wiec to prawa do items/ decyduja o zapisie (ADR 0031).
  posixNonRoot(
    'items/ tylko do odczytu: update odrzucony z przyczyna, element nietkniety, bez katalogow roboczych',
    async () => {
      const { service, itemDir, clock } = setup();
      const { item } = await service.create(draft({ body: 'v1\n' }));
      const itemsDir = join(itemDir(item.id), '..');
      const before = snapshot(itemDir(item.id));
      chmodSync(itemsDir, 0o500);

      try {
        clock.advance(1000);
        const error = await failureOf(service.update(item.id, draft({ body: 'v2\n' })));
        expect(error.reason).toBe('store-failed');
        expect((error as LibraryOperationError).failure).toBe('permission-denied');
        expect(snapshot(itemDir(item.id))).toEqual(before);
        expect(readdirSync(itemsDir)).toEqual([item.id]);
      } finally {
        chmodSync(itemsDir, 0o700);
      }
    },
  );

  posixNonRoot(
    'katalog elementu tylko do odczytu nie blokuje update: nowy stan wchodzi przez zamiane katalogu',
    async () => {
      const { service, itemDir, clock } = setup();
      const { item } = await service.create(draft({ body: 'v1\n' }));
      chmodSync(itemDir(item.id), 0o500);

      clock.advance(1000);
      await service.update(item.id, draft({ body: 'v2\n' }));

      expect(readFileSync(join(itemDir(item.id), 'body.md'), 'utf8')).toBe('v2\n');
      expect(statSync(itemDir(item.id)).mode & 0o777).toBe(0o700);
      expect((await service.list()).items).toHaveLength(1);
    },
  );

  posixNonRoot(
    'body.md tylko do odczytu w zapisywalnym katalogu: update przechodzi i plik wraca z trybem 0600',
    async () => {
      const { service, itemDir, clock } = setup();
      const { item } = await service.create(draft({ body: 'v1\n' }));
      const body = join(itemDir(item.id), 'body.md');
      chmodSync(body, 0o400);

      clock.advance(1000);
      await service.update(item.id, draft({ body: 'v2\n' }));

      expect(readFileSync(body, 'utf8')).toBe('v2\n');
      expect(statSync(body).mode & 0o777).toBe(0o600);
    },
  );
});

describe('naprawa elementu niespojnego na dysku', () => {
  async function seeded() {
    const ctx = setup();
    const v1: ItemDraft = draft({ body: 'v1\n', assets: [asset('refs/a.md', 'A1')] });
    const { item } = await ctx.service.create(v1);
    ctx.clock.advance(1000);
    return { ...ctx, item, dir: ctx.itemDir(item.id) };
  }

  it('adoptDisk po recznej edycji body.md: tresc z dysku jako nowa rewizja, surowe bajty w objects/', async () => {
    const { service, objects, item, dir } = await seeded();
    writeFileSync(join(dir, 'body.md'), 'z edytora\r\n');
    expect((await service.list()).inconsistent).toMatchObject([
      { id: item.id, files: [{ path: 'body.md', problem: 'hash-differs' }] },
    ]);

    const adopted = await service.adoptDisk(item.id);

    expect(adopted.item.version.revision).toBe(2);
    expect(adopted.item.content.body).toBe('z edytora\n');
    expect(readFileSync(join(dir, 'body.md'), 'utf8')).toBe('z edytora\n');
    expect(await objects.has(sha256Text('z edytora\r\n'))).toBe(true);
    expect((await service.list()).inconsistent).toEqual([]);
  });

  it('restoreVersion po recznej edycji body.md: wraca wersja z item.json, edycja zostaje w objects/', async () => {
    const { service, objects, item, dir } = await seeded();
    writeFileSync(join(dir, 'body.md'), 'z edytora\n');

    const restored = await service.restoreVersion(item.id);

    expect(restored.item.version.revision).toBe(2);
    expect(restored.item.content.body).toBe('v1\n');
    expect(readFileSync(join(dir, 'body.md'), 'utf8')).toBe('v1\n');
    expect(await objects.has(sha256Text('z edytora\n'))).toBe(true);
    expect((await service.list()).inconsistent).toEqual([]);
  });

  /** Stan po zabiciu procesu w trakcie zapisu: nowe body i asset sa, item.json stary, po nim tmp. */
  function interruptWrite(dir: string): void {
    writeFileSync(join(dir, 'body.md'), 'v2\n');
    writeFileSync(join(dir, 'assets', 'refs', 'a.md'), 'A2');
    writeFileSync(join(dir, '.item.json.4242.acme00.tmp'), '{"formatVersion":1,');
  }

  it('zapis przerwany przed item.json jest wykrywany przez list(), a get() go nie oddaje', async () => {
    const { service, item, dir } = await seeded();
    interruptWrite(dir);

    const list = await service.list();
    expect(list.items).toEqual([]);
    expect(list.problems).toEqual([]);
    expect(list.inconsistent).toEqual([
      {
        id: item.id,
        slug: item.identity.slug,
        kind: item.kind,
        files: expect.arrayContaining([
          { path: 'body.md', problem: 'hash-differs' },
          { path: 'assets/refs/a.md', problem: 'hash-differs' },
        ]) as unknown,
      },
    ]);
    expect((await failureOf(service.get(item.id))).reason).toBe('integrity-mismatch');
  });

  it('zapis przerwany przed item.json naprawia adoptDisk: przyjmuje nowe pliki i sprzata tmp', async () => {
    const { service, item, dir } = await seeded();
    interruptWrite(dir);

    await service.adoptDisk(item.id);

    const loaded = await service.get(item.id);
    expect(loaded.item.content.body).toBe('v2\n');
    expect(Buffer.from(loaded.assets[0]?.bytes ?? []).toString('utf8')).toBe('A2');
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('zapis przerwany przed item.json naprawia restoreVersion: wraca stan z item.json i sprzata tmp', async () => {
    const { service, item, dir } = await seeded();
    interruptWrite(dir);

    await service.restoreVersion(item.id);

    const loaded = await service.get(item.id);
    expect(loaded.item.content.body).toBe('v1\n');
    expect(Buffer.from(loaded.assets[0]?.bytes ?? []).toString('utf8')).toBe('A1');
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('osierocony plik tymczasowy w assets/ nie zostaje przyjety przez adoptDisk jako asset', async () => {
    const { service, item, dir } = await seeded();
    writeFileSync(join(dir, 'body.md'), 'v2\n');
    writeFileSync(join(dir, 'assets', 'refs', '.a.md.4242.acme00.tmp'), 'A2 urwane');

    const adopted = await service.adoptDisk(item.id);

    expect(adopted.item.assets.map((a) => a.relPath)).toEqual(['refs/a.md']);
  });
});
