import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import type { Sha256 } from '../../src/core/model/item';
import { MAX_FILE_BYTES } from '../../src/core/model/library-limits';
import { createUlidGenerator } from '../../src/core/ports/id-generator';
import { LibraryService } from '../../src/core/services/library/library-service';
import { FsLibraryGit } from '../../src/infra/library/library-git';
import { FsLibraryStore } from '../../src/infra/library/library-store';
import { FsObjectStore } from '../../src/infra/store/object-store';
import { createTempTree, removeTempTrees } from '../harness/isolation';
import { filler } from '../unit/security-secrets';
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

describe('LibraryService na prawdziwym LibraryStore i ObjectStore', () => {
  it('create, update, planDelete, applyDelete: historia w objects/ przezywa usuniecie', async () => {
    const root = createTempTree('acme-e2e-');
    const clock = new FakeClock();
    const log = new MemoryOperationLog();
    const objects = new FsObjectStore(join(root, 'objects'));
    const store = new FsLibraryStore(join(root, 'library'));
    const service = new LibraryService({
      store,
      objects,
      log,
      ids: createUlidGenerator(clock, deterministicRandom()),
      clock,
    });

    const created = await service.create(
      draft({
        body: 'wersja 1\n',
        assets: [{ relPath: 'dane/plik.txt', bytes: bytes('asset v1') }],
      }),
    );
    const id = created.item.id;
    expect(created.item.version.revision).toBe(1);

    clock.advance(1000);
    const updated = await service.update(
      id,
      draft({
        body: 'wersja 2\n',
        assets: [{ relPath: 'dane/plik.txt', bytes: bytes('asset v2') }],
      }),
    );
    expect(updated.item.version.revision).toBe(2);

    // Poprzednia wersja jest w objects/ i odtwarza sie z rekordu wersji (ADR 0028, 0031).
    const archived = log.records[1]?.before;
    expect(archived?.revision).toBe(1);
    const record = await objects.get(archived?.versionHash as Sha256);
    expect(record).not.toBeNull();
    expect(JSON.parse(new TextDecoder().decode(record ?? new Uint8Array()))).toMatchObject({
      version: { revision: 1 },
    });
    const v1Asset = await objects.get(created.item.assets[0]?.bytesHash as Sha256);
    expect(new TextDecoder().decode(v1Asset ?? new Uint8Array())).toBe('asset v1');

    const plan = await service.planDelete(id);
    expect(plan.applicable).toBe(true);
    expect(plan.revision).toBe(2);
    expect(existsSync(join(root, 'library', 'items', id))).toBe(true);

    await service.applyDelete(plan);

    expect(existsSync(join(root, 'library', 'items', id))).toBe(false);
    expect((await service.list()).items).toEqual([]);
    const deleted = log.records[2]?.before;
    expect(deleted?.revision).toBe(2);
    expect(await objects.has(deleted?.versionHash as Sha256)).toBe(true);
    const v2Asset = await objects.get(updated.item.assets[0]?.bytesHash as Sha256);
    expect(new TextDecoder().decode(v2Asset ?? new Uint8Array())).toBe('asset v2');
  });

  it('za duzy body.md cudzego elementu nie blokuje create', async () => {
    const root = createTempTree('acme-big-');
    const clock = new FakeClock();
    const service = new LibraryService({
      store: new FsLibraryStore(join(root, 'library')),
      objects: new FsObjectStore(join(root, 'objects')),
      log: new MemoryOperationLog(),
      ids: createUlidGenerator(clock, deterministicRandom()),
      clock,
    });
    const other = await service.create(draft({ slug: 'acme-other' }));
    writeFileSync(
      join(root, 'library', 'items', other.item.id, 'body.md'),
      Buffer.alloc(MAX_FILE_BYTES + 1, 0x61),
    );

    await expect(service.create(draft({ slug: 'acme-new' }))).resolves.toBeDefined();
    // Cudzy element jest widoczny w list() jako problem, a nie psuje zapisow.
    const listed = await service.list();
    expect(listed.items.map((i) => i.identity.slug)).toContain('acme-new');
  });
});

/**
 * Lokalne repozytorium biblioteki na prawdziwym `git` w katalogu tymczasowym (ADR 0060). Sprawdza to, czego
 * atrapa nie pokaze: wykluczenia z historii, brak `.git` w bibliotece, autora, wylaczone hooki i konfiguracje
 * uzytkownika oraz bajty plikow pomocniczych, ktore probuja ukryc sie przed `git add` albo zmienic filtrem.
 */
describe.skipIf(process.platform === 'win32')('FsLibraryGit na prawdziwym git (ADR 0060)', () => {
  const clean = { scope: 'public', secretFindings: [] } as const;
  const leaked = {
    scope: 'public',
    secretFindings: [{ rule: 'acme-token', relPath: 'body.md', line: 1 }],
  } as const;

  function setup() {
    const root = createTempTree('acme-libgit-');
    const clock = new FakeClock();
    const service = new LibraryService({
      store: new FsLibraryStore(join(root, 'library')),
      objects: new FsObjectStore(join(root, 'objects')),
      log: new MemoryOperationLog(),
      ids: createUlidGenerator(clock, deterministicRandom()),
      clock,
    });
    const gitDir = join(root, 'library-git');
    const git = new FsLibraryGit({ libraryDir: join(root, 'library'), gitDir });
    const read = (...args: string[]): string =>
      execFileSync(
        'git',
        [`--git-dir=${gitDir}`, `--work-tree=${join(root, 'library')}`, ...args],
        {
          cwd: join(root, 'library'),
          env: {
            PATH: process.env['PATH'] ?? '',
            HOME: root,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
          },
          encoding: 'utf8',
        },
      );
    return { root, gitDir, service, git, read };
  }

  it('commit po operacji: autor neutralny, liczba elementow w temacie, brak .git w bibliotece', async () => {
    const { root, service, git, read } = setup();
    expect(await git.probe()).toEqual({ available: true });
    expect((await git.status(false, true)).repository).toBe(false);

    const open = await service.create(draft({ slug: 'acme-open', classification: clean }));
    await service.create(draft({ slug: 'acme-closed' }));
    const first = await git.sync({ operation: 'enable', includePrivate: false });
    expect(first).toEqual({ ok: true, committed: true, items: 1 });
    expect(read('log', '-1', '--format=%an <%ae>|%cn <%ce>|%s').trim()).toBe(
      'cwm <cwm@localhost>|cwm <cwm@localhost>|enable: 1 item',
    );
    expect(
      read('ls-files')
        .trim()
        .split('\n')
        .every((f) => f.startsWith(`items/${open.item.id}/`)),
    ).toBe(true);
    expect(existsSync(join(root, 'library', '.git'))).toBe(false);

    expect(await git.sync({ operation: 'save', includePrivate: false })).toEqual({
      ok: true,
      committed: false,
      items: 0,
    });

    await service.update(
      open.item.id,
      draft({ slug: 'acme-open', classification: clean, body: 'zmiana\n' }),
    );
    expect(await git.sync({ operation: 'save', includePrivate: false })).toEqual({
      ok: true,
      committed: true,
      items: 1,
    });
    expect(read('show', `HEAD:items/${open.item.id}/body.md`)).toBe('zmiana\n');
    const status = await git.status(false, true);
    expect(status).toMatchObject({
      repository: true,
      commits: 2,
      last: { subject: 'save: 1 item' },
      items: { included: 1, excludedPrivate: 1, excludedSecrets: 0, excludedUnreadable: 0 },
    });
  });

  it('prywatne za zgoda, sekret nigdy, nieczytelne nigdy; wycofanie zgody zdejmuje z indeksu', async () => {
    const { root, service, git, read } = setup();
    const open = await service.create(draft({ slug: 'acme-open', classification: clean }));
    const closed = await service.create(draft({ slug: 'acme-closed' }));
    const secret = await service.create(draft({ slug: 'acme-secret', classification: leaked }));
    const broken = await service.create(draft({ slug: 'acme-broken', classification: clean }));
    writeFileSync(join(root, 'library', 'items', broken.item.id, 'item.json'), '{ nie json');

    await git.sync({ operation: 'enable', includePrivate: false });
    const tracked = (): string[] => [
      ...new Set(
        read('ls-files')
          .trim()
          .split('\n')
          .map((f) => f.split('/')[1] ?? ''),
      ),
    ];
    expect(tracked()).toEqual([open.item.id]);
    const exclude = readFileSync(join(root, 'library-git', 'info', 'exclude'), 'utf8');
    for (const id of [closed.item.id, secret.item.id, broken.item.id]) {
      expect(exclude).toContain(`/items/${id}/`);
    }

    await git.sync({ operation: 'resync', includePrivate: true });
    expect(tracked().sort()).toEqual([open.item.id, closed.item.id].sort());
    expect(await git.status(true, true)).toMatchObject({
      items: { included: 2, excludedPrivate: 0, excludedSecrets: 1, excludedUnreadable: 1 },
    });

    await git.sync({ operation: 'resync', includePrivate: false });
    expect(tracked()).toEqual([open.item.id]);
    // Historia nie jest przepisywana: wersja z czasu zgody zostaje w poprzednim commicie (ADR 0060, punkt 6).
    expect(read('log', '--format=%s').trim().split('\n')).toEqual([
      'resync: 1 item',
      'resync: 1 item',
      'enable: 1 item',
    ]);

    await service.applyDelete(await service.planDelete(open.item.id));
    expect(await git.sync({ operation: 'delete', includePrivate: false })).toMatchObject({
      ok: true,
      committed: true,
    });
    expect(tracked()).toEqual(['']);
  });

  it('plik pomocniczy .gitignore i .gitattributes nie ukrywa tresci ani jej nie zmienia', async () => {
    const { service, git, read } = setup();
    const crlf = bytes('a\r\nb\n');
    const created = await service.create(
      draft({
        slug: 'acme-tricky',
        classification: clean,
        assets: [
          { relPath: 'ref/.gitignore', bytes: bytes('*\n') },
          { relPath: 'ref/.gitattributes', bytes: bytes('* text eol=lf filter=acme\n') },
          { relPath: 'ref/dane.txt', bytes: crlf },
        ],
      }),
    );
    await git.sync({ operation: 'enable', includePrivate: false });
    const base = `items/${created.item.id}/assets/ref`;
    expect(read('ls-files').trim().split('\n')).toEqual(
      expect.arrayContaining([`${base}/.gitignore`, `${base}/.gitattributes`, `${base}/dane.txt`]),
    );
    expect(read('show', `HEAD:${base}/dane.txt`)).toBe('a\r\nb\n');
  });

  it('hooki repozytorium i konfiguracja uzytkownika nie dzialaja', async () => {
    const { root, gitDir, service, git, read } = setup();
    // Konfiguracja globalna z innym autorem, podpisem i hookiem: srodowisko procesu jej nie czyta.
    const home = join(root, 'home');
    mkdirSync(home);
    writeFileSync(
      join(home, '.gitconfig'),
      '[user]\n\tname = Prawdziwa Osoba\n\temail = osoba@example.com\n[commit]\n\tgpgsign = true\n',
    );
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CONFIG_HOME', home);
    try {
      await service.create(draft({ slug: 'acme-open', classification: clean }));
      await git.sync({ operation: 'enable', includePrivate: false });
      // Hooki z magazynu obiektow powstaly po `init`; pelne wylaczenie to `core.hooksPath=/dev/null`.
      const marker = join(root, 'hook-ran');
      mkdirSync(join(gitDir, 'hooks'), { recursive: true });
      for (const name of ['pre-commit', 'commit-msg', 'post-commit', 'reference-transaction']) {
        const hook = join(gitDir, 'hooks', name);
        writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
        chmodSync(hook, 0o755);
      }
      await service.create(draft({ slug: 'acme-next', classification: clean }));
      expect(await git.sync({ operation: 'save', includePrivate: false })).toMatchObject({
        ok: true,
        committed: true,
      });
      expect(existsSync(marker)).toBe(false);
      expect(read('log', '-1', '--format=%an <%ae>').trim()).toBe('cwm <cwm@localhost>');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('martwe zamki po przerwanym poleceniu nie blokuja kolejnych commitow (M2)', async () => {
    const { gitDir, service, git } = setup();
    await service.create(draft({ slug: 'acme-open', classification: clean }));
    await git.sync({ operation: 'enable', includePrivate: false });
    // Zamki wszystkich rodzajow, takze swieze: kolejka jest jedynym pisarzem, wiec zaden nie jest zywy.
    const locks = ['index.lock', 'HEAD.lock', 'packed-refs.lock', 'shallow.lock'].map((name) =>
      join(gitDir, name),
    );
    mkdirSync(join(gitDir, 'refs', 'heads'), { recursive: true });
    locks.push(join(gitDir, 'refs', 'heads', 'main.lock'));
    for (const lock of locks) writeFileSync(lock, '');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(locks[0] ?? '', old, old);
    await service.create(draft({ slug: 'acme-next', classification: clean }));
    expect(await git.sync({ operation: 'save', includePrivate: false })).toMatchObject({
      ok: true,
      committed: true,
    });
    for (const lock of locks) expect(existsSync(lock)).toBe(false);
  });

  it('sekret dopisany po imporcie nie trafia do historii mimo pustych secretFindings (H1)', async () => {
    const { service, git, read } = setup();
    const created = await service.create(draft({ slug: 'acme-open', classification: clean }));
    await git.sync({ operation: 'enable', includePrivate: false });
    expect((await git.status(false, true)).items.included).toBe(1);

    // Edycja z pominieciem `library:save`: classification zostaje czysta, tresc dostaje wartosc przypisana do klucza.
    // Wartosc sklada sie w czasie testu, zeby zrodlo nie zawieralo ciagu, ktory gitleaks uzna za sekret.
    const secretValue = filler(24);
    await service.update(
      created.item.id,
      draft({
        slug: 'acme-open',
        classification: clean,
        body: `# Acme\n\n${['api', '_key'].join('')} = ${secretValue}\n`,
      }),
    );
    const result = await git.sync({ operation: 'save', includePrivate: false });
    expect(result).toMatchObject({ ok: true, committed: true });
    expect(read('ls-files').trim()).toBe('');
    expect(await git.status(false, true)).toMatchObject({
      items: { included: 0, excludedSecrets: 1 },
    });
    // Ani w aktualnym drzewie, ani w zadnym commicie nie ma wartosci.
    expect(read('log', '-p', '--all')).not.toContain(secretValue);

    // Sekret w pliku pomocniczym i w tytule tez wyklucza.
    const viaAsset = await service.create(
      draft({
        slug: 'acme-asset',
        classification: clean,
        assets: [
          {
            relPath: 'ref/notatki.txt',
            bytes: bytes(`${['tok', 'en'].join('')}: ${filler(16, 3)}`),
          },
        ],
      }),
    );
    await git.sync({ operation: 'save', includePrivate: false });
    expect(read('ls-files').trim()).toBe('');
    expect(viaAsset.item.id).toBeDefined();
  });

  it('wpis .git gdziekolwiek w elemencie wyklucza go z widocznym powodem (L1)', async () => {
    const { service, git, read } = setup();
    await service.create(
      draft({
        slug: 'acme-nested',
        classification: clean,
        assets: [{ relPath: 'ref/.git', bytes: bytes('gitdir: /nigdzie\n') }],
      }),
    );
    await service.create(draft({ slug: 'acme-open', classification: clean }));
    await git.sync({ operation: 'enable', includePrivate: false });
    expect(await git.status(false, true)).toMatchObject({
      items: { included: 1, excludedGitEntry: 1 },
    });
    expect(read('ls-files').trim().split('\n')).toHaveLength(2);
  });

  it('konfiguracja magazynu jest przepisywana z szablonu, a pliki przekierowujace blokuja uruchomienie (M1)', async () => {
    const { root, gitDir, service, git } = setup();
    await service.create(draft({ slug: 'acme-open', classification: clean }));
    await git.sync({ operation: 'enable', includePrivate: false });
    const marker = join(root, 'config-ran');
    const hook = join(root, 'tamper.sh');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(hook, 0o755);
    writeFileSync(
      join(gitDir, 'config'),
      `[core]\n\tfsmonitor = ${hook}\n\tsshCommand = ${hook}\n\thooksPath = ${root}\n` +
        `[user]\n\tname = Prawdziwa Osoba\n[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = ${hook}\n` +
        `[diff]\n\texternal = ${hook}\n[include]\n\tpath = ${hook}\n`,
    );
    await service.create(draft({ slug: 'acme-next', classification: clean }));
    // Odczyt stanu tez przechodzi przez przepisanie konfiguracji.
    expect((await git.status(false, true)).commits).toBe(1);
    expect(readFileSync(join(gitDir, 'config'), 'utf8')).not.toContain('fsmonitor');
    writeFileSync(join(gitDir, 'config'), `[core]\n\tfsmonitor = ${hook}\n`);
    expect(await git.sync({ operation: 'save', includePrivate: false })).toMatchObject({
      ok: true,
      committed: true,
    });
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(gitDir, 'config'), 'utf8')).toBe(
      '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = false\n',
    );

    for (const [index, file] of [
      ['commondir'],
      ['gitdir'],
      ['objects', 'info', 'alternates'],
    ].entries()) {
      const path = join(gitDir, ...file);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, root);
      await service.create(draft({ slug: `acme-refused-${index}`, classification: clean }));
      const refused = await git.sync({ operation: 'save', includePrivate: false });
      expect(refused.ok).toBe(false);
      expect(JSON.stringify(refused)).not.toContain(root);
      rmSync(path);
    }
  });

  it('awaria gita to wynik z komunikatem bez sciezek, nie wyjatek, a biblioteka dziala dalej', async () => {
    const { root, service } = setup();
    const broken = new FsLibraryGit({
      libraryDir: join(root, 'library'),
      // Plik zamiast katalogu na magazyn obiektow: nie da sie go utworzyc.
      gitDir: join(root, 'to-jest-plik'),
    });
    writeFileSync(join(root, 'to-jest-plik'), 'x');
    const result = await broken.sync({ operation: 'save', includePrivate: false });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(root);
    await expect(service.create(draft({ slug: 'acme-still-works' }))).resolves.toBeDefined();
  });
});
