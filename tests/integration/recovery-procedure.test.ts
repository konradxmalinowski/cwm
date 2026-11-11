import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';

import { createUlidGenerator } from '../../src/core/ports/id-generator';
import { LibraryService } from '../../src/core/services/library/library-service';
import { SqliteIndexStore } from '../../src/infra/db/index-store';
import { quarantineIndex } from '../../src/infra/db/quarantine';
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

import {
  ALL_LINKS,
  NO_LINKS,
  entry,
  makeFixture,
  makePlan,
  text,
  treeHash,
  type Fixture,
} from './write-gate-fixture';

/**
 * Dowod dla ROADMAP Etap 10, kryterium 3: procedura z docs/ODZYSKIWANIE.md dziala bez aplikacji.
 *
 * Kopia powstaje przez prawdziwy WriteGate, a odtworzenie to dokladnie kroki z dokumentu
 * (oznaczenia A1, B2 itd. odpowiadaja sekcjom), wykonane samym `node:fs`. Kod aplikacji
 * (BackupStore, ObjectStore, LibraryStore) w krokach odzyskiwania nie jest uzywany. Do zapisu
 * stanu poczatkowego uzywamy go tylko tam, gdzie opisujemy, skad pliki pochodza.
 */

afterAll(() => {
  removeTempTrees();
});

const posix = process.platform !== 'win32';
const sha256 = (data: Uint8Array | string): string =>
  createHash('sha256').update(data).digest('hex');
const read = (path: string): string => readFileSync(path, 'utf8');

interface ManifestEntry {
  index: number;
  path: string;
  action: string;
  before: {
    state: 'file' | 'missing' | 'symlink';
    sha256?: string;
    mode?: string;
    backupFile?: string;
    linkTarget?: string;
  };
  after: { state: string };
}
interface VersionRecord {
  content?: { body?: unknown };
  version?: { revision: number };
  assets?: { bytesHash: string }[];
}
interface Manifest {
  createdAt: string;
  tool: string;
  entries: ManifestEntry[];
}

/** Stan poczatkowy drzewa narzedzia: plik z trybem, dowiazanie do katalogu i plik, ktory zapis zamieni na dowiazanie. */
function arrange(f: Fixture): void {
  mkdirSync(join(f.skillsRoot, 'acme'));
  const old = join(f.skillsRoot, 'acme', 'old.md');
  writeFileSync(old, 'stare');
  if (posix) chmodSync(old, 0o640);
  if (posix) {
    mkdirSync(join(f.outside, 'cel-dowiazania'));
    writeFileSync(join(f.outside, 'cel-dowiazania', 'SKILL.md'), 'cudzy skill');
    symlinkSync(join(f.outside, 'cel-dowiazania'), join(f.skillsRoot, 'linked'));
    writeFileSync(join(f.skillsRoot, 'plik.md'), 'reczna wersja');
  }
}

async function exportScenario(f: Fixture): Promise<string> {
  const entries = [
    entry({
      relPath: 'acme/old.md',
      action: 'modify',
      previous: text('stare'),
      content: text('nowe'),
    }),
    entry({ relPath: 'acme/SKILL.md', content: text('nowy skill\n') }),
    entry({ relPath: 'nowy/SKILL.md', content: text('w nowym katalogu\n') }),
  ];
  if (posix) {
    entries.push(
      entry({
        relPath: 'linked',
        action: 'link',
        content: null,
        files: [{ relPath: 'SKILL.md', bytes: text('skill z biblioteki') }],
      }),
      entry({
        relPath: 'plik.md',
        action: 'link',
        content: text('tresc z biblioteki\n'),
        previous: text('reczna wersja'),
      }),
    );
  }
  const probed = await f.gate.probe(makePlan(entries));
  expect(probed.applicable).toBe(true);
  const report = await f.gate.apply(probed, { planId: probed.planId });
  expect(report.verified).toBe(true);
  expect(report.backupId).not.toBe('');
  return report.backupId;
}

function toolTree(f: Fixture): string {
  return treeHash(join(f.tree, 'tool'));
}

/** Usuwa to, co jest pod sciezka: plik albo samo dowiazanie, a katalog tylko pusty. */
function removeOne(path: string): void {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return;
  }
  if (info.isDirectory() && !info.isSymbolicLink()) rmdirSync(path);
  else unlinkSync(path);
}

describe('A. odtworzenie plikow narzedzia z backups/<id>/', () => {
  it('A1-A4: kroki z dokumentu przywracaja drzewo bajt w bajt', async () => {
    const f = makeFixture({ capability: posix ? ALL_LINKS : NO_LINKS });
    arrange(f);
    const before = toolTree(f);
    const backupId = await exportScenario(f);
    expect(toolTree(f)).not.toBe(before);

    // A1: kopia to katalog backups/<id> z MANIFEST.
    const backupDir = join(f.userData, 'backups', backupId);
    expect(readdirSync(join(f.userData, 'backups'))).toEqual([backupId]);

    // A2: MANIFEST to zwykly JSON.
    const manifest = JSON.parse(read(join(backupDir, 'MANIFEST'))) as Manifest;
    expect(manifest.tool).toBe('claude-code');
    expect(manifest.entries.length).toBeGreaterThanOrEqual(3);

    // A3: wpisy od ostatniego do pierwszego.
    const ordered = [...manifest.entries].sort((a, b) => b.index - a.index);
    for (const e of ordered) {
      switch (e.before.state) {
        case 'file': {
          // krok 1: dowiazanie pod path usuwamy, zeby nie zapisac pliku w jego celu.
          if (lstatSync(e.path, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
            unlinkSync(e.path);
          }
          // krok 2: kopia na path.
          copyFileSync(join(backupDir, ...(e.before.backupFile ?? '').split('/')), e.path);
          // krok 3: uprawnienia z pola mode (tylko macOS i Linux).
          if (posix) chmodSync(e.path, parseInt(e.before.mode ?? '0644', 8));
          // krok 4: suma kontrolna.
          expect(sha256(readFileSync(e.path))).toBe(e.before.sha256);
          break;
        }
        case 'missing':
          removeOne(e.path);
          break;
        case 'symlink':
          removeOne(e.path);
          symlinkSync(e.before.linkTarget ?? '', e.path);
          break;
      }
    }

    // A4: katalog utworzony przez zapis zostaje pusty i usuwamy go.
    const created = join(f.skillsRoot, 'nowy');
    expect(readdirSync(created)).toEqual([]);
    expect(toolTree(f)).not.toBe(before);
    rmdirSync(created);

    expect(toolTree(f)).toBe(before);
    if (posix) {
      expect(readlinkSync(join(f.skillsRoot, 'linked'))).toBe(join(f.outside, 'cel-dowiazania'));
      expect(read(join(f.skillsRoot, 'plik.md'))).toBe('reczna wersja');
      expect(lstatSync(join(f.skillsRoot, 'plik.md')).isSymbolicLink()).toBe(false);
      expect(lstatSync(join(f.skillsRoot, 'acme', 'old.md')).mode & 0o777).toBe(0o640);
    }
  });

  it('A5: bez katalogu backups/<id> ta sama tresc jest w objects/<aa>/<sha256>', async () => {
    const f = makeFixture({ capability: posix ? ALL_LINKS : NO_LINKS });
    arrange(f);
    const backupId = await exportScenario(f);
    const manifest = JSON.parse(
      read(join(f.userData, 'backups', backupId, 'MANIFEST')),
    ) as Manifest;
    rmSync(join(f.userData, 'backups'), { recursive: true, force: true });

    const target = manifest.entries.find((e) => e.path.endsWith('old.md'));
    expect(target?.before.state).toBe('file');
    const hash = target?.before.sha256 ?? '';
    const object = join(f.userData, 'objects', hash.slice(0, 2), hash);
    copyFileSync(object, target?.path ?? '');

    expect(read(join(f.skillsRoot, 'acme', 'old.md'))).toBe('stare');
    expect(sha256(readFileSync(object))).toBe(hash);
  });
});

describe('D. skill, ktorego dowiazanie wskazuje w prozni', () => {
  it('D1: usuniecie dowiazania i skopiowanie materialized/<narzedzie>/<nazwa> w jego miejsce', async () => {
    if (!posix) return;
    const f = makeFixture({ capability: ALL_LINKS });
    const probed = await f.gate.probe(
      makePlan([
        entry({
          relPath: 'acme-skill',
          action: 'link',
          content: null,
          files: [{ relPath: 'SKILL.md', bytes: text('tresc skilla') }],
        }),
      ]),
    );
    await f.gate.apply(probed, { planId: probed.planId });
    const link = join(f.skillsRoot, 'acme-skill');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);

    // Kopia katalogu danych, potem jego utrata.
    const saved = join(f.tree, 'kopia-userData');
    cpSync(f.userData, saved, { recursive: true });
    rmSync(join(f.userData, 'materialized'), { recursive: true, force: true });
    expect(existsSync(join(link, 'SKILL.md'))).toBe(false);

    unlinkSync(link);
    cpSync(join(saved, 'materialized', 'claude-code', 'acme-skill'), link, { recursive: true });

    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(read(join(link, 'SKILL.md'))).toBe('tresc skilla');
  });
});

function libraryApp(root: string, log: MemoryOperationLog = new MemoryOperationLog()) {
  const clock = new FakeClock();
  return new LibraryService({
    store: new FsLibraryStore(join(root, 'library')),
    objects: new FsObjectStore(join(root, 'objects')),
    log,
    ids: createUlidGenerator(clock, deterministicRandom()),
    clock,
    index: () => null,
  });
}

describe('B. odzyskanie elementu biblioteki', () => {
  it('B1-B3: skill z library/items i poprzednia wersja z objects/', async () => {
    const root = createTempTree('acme-recover-');
    const service = libraryApp(root);
    const frontmatter = '---\nname: acme-recover\ndescription: Opis ze zrodla.\n---\n';
    const created = await service.create(
      draft({
        slug: 'acme-recover',
        body: 'Tresc v1\n',
        assets: [{ relPath: 'refs/a.md', bytes: bytes('plik pomocniczy') }],
        source: {
          importedFrom: null,
          snapshots: [
            {
              tool: 'claude-code',
              files: [
                { relPath: 'SKILL.md', bytes: bytes(`${frontmatter}Tresc v1\n`), mode: 0o644 },
              ],
              unmappedKeys: [],
            },
          ],
        },
      }),
    );
    const id = created.item.id;
    await service.update(id, draft({ slug: 'acme-recover', body: 'Tresc v2\n' }));

    // B1: element znajdujemy po slugu w item.json.
    const itemsDir = join(root, 'library', 'items');
    const found = readdirSync(itemsDir).filter((name) => {
      if (name.startsWith('.')) return false;
      const meta = JSON.parse(read(join(itemsDir, name, 'item.json'))) as {
        identity: { slug: string };
      };
      return meta.identity.slug === 'acme-recover';
    });
    expect(found).toEqual([id]);
    const itemDir = join(itemsDir, id);

    // B2: katalog skilla ze snapshotu, plikow pomocniczych i body.md.
    const skillDir = join(root, 'odtworzone', 'acme-recover');
    cpSync(join(itemDir, 'snapshots', 'claude-code'), skillDir, { recursive: true });
    cpSync(join(itemDir, 'assets'), skillDir, { recursive: true });
    const snapshotMd = read(join(skillDir, 'SKILL.md'));
    const head = /^---\n[\s\S]*?\n---\n/.exec(snapshotMd)?.[0] ?? '';
    expect(head).toBe(frontmatter);
    writeFileSync(join(skillDir, 'SKILL.md'), head + read(join(itemDir, 'body.md')));

    expect(read(join(skillDir, 'SKILL.md'))).toBe(`${frontmatter}Tresc v2\n`);
    expect(read(join(skillDir, 'refs', 'a.md'))).toBe('plik pomocniczy');

    // B3: poprzednia wersja z rekordow w objects/ znalezionych po id elementu.
    const objectsDir = join(root, 'objects');
    const records: { file: string; revision: number; body: string; json: VersionRecord }[] = [];
    for (const shard of readdirSync(objectsDir)) {
      for (const name of readdirSync(join(objectsDir, shard))) {
        const file = join(objectsDir, shard, name);
        const content = read(file);
        if (!content.includes(`"id": "${id}"`)) continue;
        const json = JSON.parse(content) as VersionRecord;
        if (typeof json.content?.body !== 'string') continue;
        records.push({
          file,
          revision: json.version?.revision ?? 0,
          body: String(json.content?.body),
          json,
        });
      }
    }
    records.sort((a, b) => a.revision - b.revision);
    expect(records.map((r) => r.body)).toEqual(['Tresc v1\n', 'Tresc v2\n']);

    const meta = JSON.parse(read(join(itemDir, 'item.json'))) as { versionRecordHash: string };
    const latest = records[1];
    expect(latest?.file.endsWith(meta.versionRecordHash)).toBe(true);

    const old = records[0];
    expect(old).toBeDefined();
    // Skrot SHA-256 pliku jest jego nazwa.
    expect(sha256(readFileSync(old?.file ?? ''))).toBe(old?.file.split(/[\\/]/).pop());
    const assetHash = (old?.json.assets ?? [])[0]?.bytesHash ?? '';
    const assetBytes = join(objectsDir, assetHash.slice(0, 2), assetHash);
    expect(read(assetBytes)).toBe('plik pomocniczy');
    expect(existsSync(dirname(assetBytes))).toBe(true);
  });
});

describe('C. indeks w kwarantannie', () => {
  it('plik jest nietkniety, log operacji da sie odczytac, biblioteka zostaje w plikach', async () => {
    const root = createTempTree('acme-quarantine-');
    const dbPath = join(root, 'index.db');
    const store = SqliteIndexStore.open(dbPath, { home: root });
    const clock = new FakeClock();
    const service = new LibraryService({
      store: new FsLibraryStore(join(root, 'library')),
      objects: new FsObjectStore(join(root, 'objects')),
      log: store.operationLog(),
      ids: createUlidGenerator(clock, deterministicRandom()),
      clock,
      index: () => null,
    });
    const { item } = await service.create(draft({ slug: 'acme-historia' }));
    store.close();

    const originalHash = sha256(readFileSync(dbPath));
    const result = quarantineIndex(dbPath, join(root, 'quarantine'), '2026-11-10T20-00-00-000Z');
    expect(existsSync(dbPath)).toBe(false);
    const quarantined = join(result.directory, 'index-2026-11-10T20-00-00-000Z.sqlite');
    expect(sha256(readFileSync(quarantined))).toBe(originalHash);

    // Zamiennik `sqlite3 -readonly <plik> "SELECT ..."` z dokumentu.
    const db = new Database(quarantined, { readonly: true });
    try {
      const rows = db
        .prepare('SELECT seq, at, operation, slug, tool, backup_id FROM operation_log ORDER BY seq')
        .all() as { operation: string; slug: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ operation: 'create', slug: 'acme-historia' });
    } finally {
      db.close();
    }

    // Elementy biblioteki nie zaleza od indeksu.
    expect(readdirSync(join(root, 'library', 'items'))).toEqual([item.id]);
    expect(read(join(root, 'library', 'items', item.id, 'body.md'))).toContain('Acme review');
  });
});
