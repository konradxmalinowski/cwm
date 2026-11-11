import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';

import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import type { LibraryItem } from '../../src/core/model/item';
import { createUlidGenerator } from '../../src/core/ports/id-generator';
import { LibraryService } from '../../src/core/services/library/library-service';
import { FsLibraryStore } from '../../src/infra/library/library-store';
import { FsObjectStore } from '../../src/infra/store/object-store';
import { createTempTree, removeTempTrees } from '../harness/isolation';
import { FakeClock, MemoryOperationLog, deterministicRandom } from '../unit/library-fakes';
import {
  BINARY_ASSET,
  CRLF_SOURCE,
  FIXTURE_DIR,
  FIXTURE_ITEMS,
  generateFixtureLibrary,
  type FixtureItem,
} from './library-fixture-spec';

// Jednorazowa regeneracja drzewa: CWM_WRITE_FIXTURE=1 npx vitest run tests/integration/library-fixture.test.ts
const REGENERATE = process.env['CWM_WRITE_FIXTURE'] === '1';

const FIXTURE = join(process.cwd(), FIXTURE_DIR);

beforeAll(async () => {
  if (!REGENERATE) return;
  const fresh = createTempTree('acme-fixture-gen-');
  await generateFixtureLibrary(fresh);
  rmSync(FIXTURE, { recursive: true, force: true });
  cpSync(fresh, FIXTURE, { recursive: true });
});

afterAll(() => {
  removeTempTrees();
});

/** Wszystkie pliki drzewa: sciezka z `/` w NFC -> bajty. NFC, bo kopia z HFS+ oddaje nazwy w NFD. */
function readTree(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const abs = join(entry.parentPath, entry.name);
    const rel = relative(dir, abs).split('\\').join('/').normalize('NFC');
    out.set(rel, readFileSync(abs));
  }
  return out;
}

function serviceOver(root: string) {
  const clock = new FakeClock(Date.UTC(2027, 0, 1));
  const objects = new FsObjectStore(join(root, 'objects'));
  const service = new LibraryService({
    store: new FsLibraryStore(join(root, 'library')),
    objects,
    log: new MemoryOperationLog(),
    ids: createUlidGenerator(clock, deterministicRandom()),
    clock,
  });
  return { service, objects, clock };
}

/** Kopia drzewa z repozytorium do katalogu tymczasowego: tak wyglada przeniesienie biblioteki na inna maszyne. */
function copiedFixture() {
  const root = createTempTree('acme-fixture-');
  cpSync(FIXTURE, root, { recursive: true });
  return { root, ...serviceOver(root) };
}

function expectedFor(item: LibraryItem): FixtureItem {
  const spec = FIXTURE_ITEMS.find(
    (f) => f.draft.kind === item.kind && f.draft.identity.slug === item.identity.slug,
  );
  if (spec === undefined) throw new Error(`element spoza specyfikacji: ${item.identity.slug}`);
  return spec;
}

describe('kryterium 10: biblioteka zapisana na Linuksie otwiera sie na kazdym systemie', () => {
  it('list() widzi wszystkie elementy, bez problems i bez inconsistent', async () => {
    const { service } = copiedFixture();
    const list = await service.list();

    expect(list.problems).toEqual([]);
    expect(list.inconsistent).toEqual([]);
    expect(list.items.map((i) => `${i.kind}:${i.identity.slug}`).sort()).toEqual(
      FIXTURE_ITEMS.map((f) => `${f.draft.kind}:${f.draft.identity.slug}`).sort(),
    );
  });

  it('get() kazdego elementu oddaje tresc, tozsamosc i bajty plikow zgodne ze specyfikacja', async () => {
    const { root, service } = copiedFixture();
    // Id z katalogow, nie z list(): element odrzucony przez list() tez musi przejsc przez get().
    const ids = readdirSync(join(root, 'library', 'items'));
    expect(ids).toHaveLength(FIXTURE_ITEMS.length);

    for (const id of ids) {
      const { item, assets, snapshotFiles } = await service.get(id);
      const spec = expectedFor(item);
      const current = spec.update ?? spec.draft;

      expect(item.content.body).toBe(current.content.body);
      expect(item.identity).toEqual(current.identity);
      expect(item.attributes).toEqual(current.attributes ?? {});
      expect(item.version.revision).toBe(spec.update === undefined ? 1 : 2);

      const expectedAssets = (current.assets ?? []).map((a) => [a.relPath, Buffer.from(a.bytes)]);
      expect(assets.map((a) => [a.relPath, Buffer.from(a.bytes)])).toEqual(
        expect.arrayContaining(expectedAssets),
      );
      expect(assets).toHaveLength(expectedAssets.length);

      const expectedSnapshots = (current.source?.snapshots ?? []).flatMap((s) =>
        s.files.map((f) => [s.tool, f.relPath, Buffer.from(f.bytes)]),
      );
      expect(snapshotFiles.map((f) => [f.tool, f.relPath, Buffer.from(f.bytes)])).toEqual(
        expectedSnapshots,
      );
    }
  });

  it('rozjechany slug i declaredName przezywa przeniesienie bez zmian', async () => {
    const { service } = copiedFixture();
    const planner = (await service.list()).items.find((i) => i.identity.slug === 'acme-planner');
    expect(planner?.identity).toEqual({
      slug: 'acme-planner',
      declaredName: 'acme-architect',
      aliases: [],
    });
  });

  it('bajty w checkoucie sa tymi, ktore zapisal generator: CRLF, binaria i obiekty bez konwersji', () => {
    const files = readTree(FIXTURE);
    expect(files.size).toBeGreaterThan(0);

    const crlf = [...files].filter(([rel]) => rel.endsWith('commands/acme-deploy.md'));
    expect(crlf).toHaveLength(1);
    expect(crlf[0]?.[1]).toEqual(Buffer.from(CRLF_SOURCE));

    const binary = [...files].filter(([rel]) => rel.endsWith('assets/bin/acme.dat'));
    expect(binary).toHaveLength(1);
    expect(binary[0]?.[1]).toEqual(Buffer.from(BINARY_ASSET));

    for (const [rel, content] of files) {
      if (rel.endsWith('/body.md') || rel.endsWith('/item.json')) {
        expect(content.includes(0x0d), `${rel} ma CR`).toBe(false);
      }
      // Nazwa obiektu to hash tresci: kazda zmiana bajtu przez git albo kopiowanie wychodzi tutaj.
      if (rel.startsWith('objects/')) {
        const name = rel.split('/').at(-1);
        expect(createHash('sha256').update(content).digest('hex'), rel).toBe(name);
      }
    }
  });

  it('biezacy kod na tym systemie zapisuje bajt w bajt to samo drzewo', async () => {
    const fresh = createTempTree('acme-fixture-gen-');
    await generateFixtureLibrary(fresh);

    const expected = readTree(FIXTURE);
    const actual = readTree(fresh);
    // Rozjazd po zmianie formatu: regeneracja przez CWM_WRITE_FIXTURE=1 (komentarz na gorze pliku).
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [rel, content] of expected) {
      expect(actual.get(rel)?.equals(content), rel).toBe(true);
    }
  });

  it('na przeniesionym drzewie dziala edycja i przywrocenie wersji z objects/ z Linuksa', async () => {
    const { root, service, clock } = copiedFixture();
    const { items } = await service.list();
    const planner = items.find((i) => i.identity.slug === 'acme-planner');
    const review = items.find((i) => i.kind === 'skill' && i.identity.slug === 'acme-review');
    if (planner === undefined || review === undefined) throw new Error('brak elementu w drzewie');

    writeFileSync(join(root, 'library', 'items', planner.id, 'body.md'), 'reczna edycja\r\n');
    expect((await service.list()).inconsistent.map((i) => i.id)).toEqual([planner.id]);
    const restored = await service.restoreVersion(planner.id);
    expect(restored.item.content.body).toBe(planner.content.body);
    expect(restored.item.version.revision).toBe(3);

    clock.advance(1000);
    const spec = expectedFor(review);
    // Draft bez `assets` zachowuje pliki pomocnicze zapisane na Linuksie.
    const updated = await service.update(review.id, {
      kind: spec.draft.kind,
      identity: spec.draft.identity,
      content: { ...spec.draft.content, body: 'Edycja po przeniesieniu.\n' },
    });
    expect(updated.item.version.revision).toBe(2);
    const reread = await serviceOver(root).service.get(review.id);
    expect(reread.assets).toHaveLength(spec.draft.assets?.length ?? 0);

    const list = await service.list();
    expect(list.problems).toEqual([]);
    expect(list.inconsistent).toEqual([]);
  });

  it('nazwy zapisane w NFD (kopia przez HFS+) czytaja sie jak NFC', async () => {
    const { root, service } = copiedFixture();
    const review = (await service.list()).items.find(
      (i) => i.kind === 'skill' && i.identity.slug === 'acme-review',
    );
    if (review === undefined) throw new Error('brak elementu w drzewie');
    const nfc = join(root, 'library', 'items', review.id, 'assets', 'zażółć gęślą jaźń.md');
    const content = readFileSync(nfc);
    unlinkSync(nfc);
    writeFileSync(nfc.normalize('NFD'), content);

    const loaded = await service.get(review.id);
    expect(loaded.assets.find((a) => a.relPath === 'zażółć gęślą jaźń.md')?.bytes).toEqual(
      new Uint8Array(content),
    );
  });

  it('najdluzsza sciezka drzewa miesci sie w MAX_PATH przy typowej sciezce runnera Windows', () => {
    // actions/checkout na windows-latest: D:\a\<repo>\<repo>\; tests/.tmp to baza harnessu.
    const checkout = 'D:\\a\\universal-ai-skills-manager\\universal-ai-skills-manager\\';
    const tempCopy = `${checkout}tests\\.tmp\\acme-fixture-XXXXXX\\`;
    const inRepo = `${checkout}${FIXTURE_DIR.split('/').join('\\')}\\`;
    const longest = [...readTree(FIXTURE).keys()].reduce((a, b) => (b.length > a.length ? b : a));

    expect(existsSync(FIXTURE)).toBe(true);
    expect(inRepo.length + longest.length).toBeLessThan(260);
    expect(tempCopy.length + longest.length).toBeLessThan(260);
  });
});
