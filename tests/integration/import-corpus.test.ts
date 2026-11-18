import { execFileSync, spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createClaudeCodeAdapter } from '../../src/adapters/claude-code';
import { createCodexAdapter } from '../../src/adapters/codex';
import { systemClock } from '../../src/core/ports/clock';
import { ImportService } from '../../src/core/services/import/import-service';
import type { GitFetchInput, GitFetchResult } from '../../src/infra/cwm/git-fetch';
import {
  FsGitSourceProvider,
  SINGLE_SKILL_LABEL,
} from '../../src/infra/git-import/git-import-source';
import { FsLocationCatalog } from '../../src/infra/platform/locations';
import { FsSourceReader } from '../../src/infra/source/fs-source-reader';
import { createTempTree, removeTempTrees } from '../harness/isolation';
import { SECRETS } from '../unit/security-secrets';
import { createHarness } from '../unit/library-fakes';

/**
 * Korpus 12.3 przez caly import: prawdziwe adaptery, prawdziwy czytnik, prawdziwy katalog
 * lokalizacji, na kopii syntetycznych fixture'ow w katalogu tymczasowym. Przypadki, ktorych
 * nie da sie trzymac w repozytorium (sekret, kolizja wielkosci liter na jednym systemie
 * plikow), sa dokladane w czasie testu.
 */

afterAll(() => {
  removeTempTrees();
});

const FIXTURES = resolve(__dirname, '..', 'fixtures');

function corpusHome(): string {
  const home = join(createTempTree('acme-corpus-'), 'home');
  cpSync(join(FIXTURES, 'claude-code', 'home'), home, { recursive: true });
  cpSync(join(FIXTURES, 'codex', 'home'), home, { recursive: true });
  return home;
}

function importer(home: string) {
  const catalog = new FsLocationCatalog(
    { platform: process.platform, homeDir: home, env: {} },
    { salt: new Uint8Array(32).fill(5) },
  );
  const lib = createHarness();
  const service = new ImportService({
    catalog,
    adapters: [createClaudeCodeAdapter(), createCodexAdapter()],
    reader: new FsSourceReader((id) => catalog.resolvePath(id)),
    library: lib.service,
    clock: systemClock,
  });
  return { catalog, lib, service };
}

async function scanAll(home: string) {
  const imp = importer(home);
  const roots = (await imp.catalog.detect()).filter((r) => r.exists).map((r) => r.rootId);
  return { ...imp, roots, report: await imp.service.scan(roots) };
}

describe("korpus fixture'ow przez caly import (ARCHITECTURE 12.3)", () => {
  it('pelny korpus: kazdy element ma status, a domyslny wybor wchodzi do biblioteki bez bledow', async () => {
    const home = corpusHome();
    const { report, service, lib, roots } = await scanAll(home);
    const json = JSON.stringify(report);
    expect(json).not.toContain(home);

    const bySlug = (slug: string) =>
      report.candidates.filter((c) => c.candidate.draft.identity.slug === slug);
    // acme-plain lezy w trzech miejscach: kopia o tej samej tresci to duplikat, kopia o innej
    // tresci to konflikt miedzy wersjami (korpus z wymagan), a pierwsza jest nowa.
    expect(
      bySlug('acme-plain')
        .map((c) => c.status)
        .sort(),
    ).toEqual(['conflict', 'duplicate', 'new']);
    // Katalog bez SKILL.md i plik bez rozszerzenia nie sa elementami, tylko pominieciami.
    expect(bySlug('acme-notes')).toEqual([]);
    expect(bySlug('acme-install-cert')).toEqual([]);
    const skippedPaths = report.skipped.map((s) => s.relPath);
    expect(skippedPaths).toEqual(expect.arrayContaining(['acme-notes', 'acme-install-cert']));

    const chosen = report.candidates.filter((c) => c.selectedByDefault).map((c) => c.candidateId);
    expect(chosen.length).toBeGreaterThan(5);
    const applied = await service.apply({ scanToken: report.scanToken, candidateIds: chosen });
    expect(applied.failed).toEqual([]);
    expect(applied.imported).toHaveLength(chosen.length);
    const listed = await lib.service.list();
    expect(listed.items).toHaveLength(chosen.length);
    expect(listed.problems).toEqual([]);

    // Idempotencja importu (12.4): drugi skan tego samego drzewa nie ma nic nowego.
    const second = await service.scan(roots);
    expect(second.candidates.filter((c) => c.status === 'new')).toEqual([]);
  });

  it('dwa skille rozne tylko wielkoscia liter: jeden nowy, drugi konflikt, w bibliotece jeden', async () => {
    const home = corpusHome();
    // Dwa rooty Codeksa, zeby przypadek dal sie zbudowac takze na APFS i NTFS bez rozrozniania liter.
    for (const [dir, name] of [
      [join(home, '.codex', 'skills', 'acme-case'), 'acme-case'],
      [join(home, '.agents', 'skills', 'ACME-Case'), 'ACME-Case'],
    ] as const) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: Acme case ${name}\n---\nTresc ${name}.\n`,
      );
    }
    const { report, service, lib } = await scanAll(home);
    const cases = report.candidates.filter(
      (c) => c.candidate.draft.identity.slug.toLowerCase() === 'acme-case',
    );
    expect(cases.map((c) => c.status).sort()).toEqual(['conflict', 'new']);
    const applied = await service.apply({
      scanToken: report.scanToken,
      candidateIds: cases.map((c) => c.candidateId),
    });
    expect(applied.imported).toHaveLength(1);
    expect(applied.skipped.map((s) => s.reason)).toEqual(['conflict']);
    const slugs = (await lib.service.list()).items.map((i) => i.identity.slug.toLowerCase());
    expect(slugs.filter((s) => s === 'acme-case')).toHaveLength(1);
  });

  it('potencjalny sekret w pliku skilla: trafienie bez wartosci, odznaczony, bez potwierdzenia nie wchodzi', async () => {
    const home = corpusHome();
    const dir = join(home, '.claude', 'skills', 'acme-leaky');
    mkdirSync(join(dir, 'references'), { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: acme-leaky\ndescription: Acme\n---\nTresc.\n');
    writeFileSync(join(dir, 'references', 'acme.env'), `ACME_KEY=${SECRETS.openai}\n`);

    const { report, service, lib } = await scanAll(home);
    const leaky = report.candidates.find((c) => c.candidate.draft.identity.slug === 'acme-leaky');
    expect(leaky?.secrets.length).toBeGreaterThan(0);
    expect(leaky?.selectedByDefault).toBe(false);
    expect(JSON.stringify(report)).not.toContain(SECRETS.openai);

    const refused = await service.apply({
      scanToken: report.scanToken,
      candidateIds: [leaky!.candidateId],
    });
    expect(refused.skipped.map((s) => s.reason)).toEqual(['secrets-not-confirmed']);
    expect((await lib.service.list()).items).toEqual([]);
  });
});

describe('import z repozytorium Git przez prawdziwe adaptery i czytnik (ADR 0058)', () => {
  const COMMIT = 'd'.repeat(40);
  const URL = 'https://example.com/acme/acme-solo.git';
  const posix = process.platform !== 'win32';

  /** Podstawia pobranie: kopia powstaje tak jak po `fetchGitSource`, w `<sources>/git/<klucz>/<commit>`. */
  function fakeFetch(populate: (copy: string) => void) {
    const calls: GitFetchInput[] = [];
    const fetch = (input: GitFetchInput): Promise<GitFetchResult> => {
      calls.push(input);
      const dir = join(input.layout.sourcesDir, 'git', 'acme', COMMIT);
      mkdirSync(dir, { recursive: true });
      populate(dir);
      return Promise.resolve({
        ok: true,
        commit: COMMIT,
        dir,
        treeSha256: 'x',
        files: 1,
        submodules: [],
        reused: false,
      });
    };
    return { fetch, calls };
  }

  function gitImporter(fetch: (input: GitFetchInput) => Promise<GitFetchResult>) {
    const work = join(createTempTree('acme-gitimport-'), 'git-import');
    const provider = new FsGitSourceProvider({ workDir: work, fetch });
    const home = createTempTree('acme-gitimport-home-');
    const catalog = new FsLocationCatalog(
      { platform: process.platform, homeDir: home, env: {} },
      { salt: new Uint8Array(32).fill(5) },
    );
    const lib = createHarness();
    const service = new ImportService({
      catalog,
      adapters: [createClaudeCodeAdapter(), createCodexAdapter()],
      reader: new FsSourceReader((id) => catalog.resolvePath(id)),
      git: provider,
      library: lib.service,
      clock: systemClock,
    });
    return { work, provider, service, lib };
  }

  it('uklad .claude: skille, agenci i komendy, bez instrukcji i hookow, a kopia znika po skanie', async () => {
    const { fetch, calls } = fakeFetch((copy) =>
      cpSync(join(FIXTURES, 'claude-code', 'home', '.claude'), join(copy, '.claude'), {
        recursive: true,
      }),
    );
    const { work, service, lib } = gitImporter(fetch);
    const report = await service.scanGit({ url: URL, ref: 'main' });

    expect(report.git).toEqual({ url: URL, ref: 'main', commit: COMMIT, submodules: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: URL, ref: 'main', commit: null });
    expect(report.candidates.length).toBeGreaterThan(5);
    expect([...new Set(report.candidates.map((c) => c.candidate.kind))].sort()).toEqual([
      'agent',
      'command',
      'skill',
    ]);
    expect([...new Set(report.candidates.map((c) => c.rootLabel))].sort()).toEqual([
      '.claude/agents',
      '.claude/commands',
      '.claude/skills',
    ]);
    expect(JSON.stringify(report)).not.toContain(work);

    // Kopia istnieje tylko na czas skanu; katalog roboczy zostaje pusty, bez sladu po repozytorium.
    expect(existsSync(join(work, 'sources'))).toBe(false);
    if (posix) expect(statSync(work).mode & 0o777).toBe(0o700);

    const chosen = report.candidates.filter((c) => c.selectedByDefault).map((c) => c.candidateId);
    const applied = await service.apply({ scanToken: report.scanToken, candidateIds: chosen });
    expect(applied.failed).toEqual([]);
    const items = (await lib.service.list()).items;
    expect(items.length).toBe(chosen.length);
    for (const item of items) {
      expect(item.source.importedFrom?.git).toEqual({ url: URL, commit: COMMIT, ref: 'main' });
    }
    // Pochodzenie nie ma sladu katalogu roboczego.
    expect(JSON.stringify(items.map((i) => i.source.importedFrom))).not.toContain(work);
  });

  it('pojedynczy SKILL.md w korzeniu: nazwa repozytorium jest nazwa elementu', async () => {
    const { fetch } = fakeFetch((copy) => {
      writeFileSync(
        join(copy, 'SKILL.md'),
        '---\nname: acme-solo\ndescription: Acme solo\n---\nTresc solo.\n',
      );
      mkdirSync(join(copy, 'references'));
      writeFileSync(join(copy, 'references', 'acme.md'), 'Pomocniczy plik.\n');
    });
    const { service, lib } = gitImporter(fetch);
    const report = await service.scanGit({ url: URL, ref: null });
    expect(report.candidates).toHaveLength(1);
    const [only] = report.candidates;
    expect(only).toMatchObject({ status: 'new', rootLabel: SINGLE_SKILL_LABEL });
    expect(only?.candidate.draft.identity.slug).toBe('acme-solo');
    expect(only?.candidate.relPath).toBe('acme-solo');
    expect(only?.candidate.draft.assets?.map((a) => a.relPath)).toEqual(['references/acme.md']);

    const applied = await service.apply({
      scanToken: report.scanToken,
      candidateIds: ['cand-1'],
    });
    expect(applied.imported).toHaveLength(1);
    const item = (await lib.service.list()).items[0];
    expect(item?.content.body).toBe('Tresc solo.\n');
    expect(item?.assets.map((a) => a.relPath)).toEqual(['references/acme.md']);
  });

  it('repozytorium bez znanego ukladu daje pusty skan, nie blad, i tez sprząta', async () => {
    const { fetch } = fakeFetch((copy) => writeFileSync(join(copy, 'README.md'), '# Acme\n'));
    const { work, service } = gitImporter(fetch);
    const report = await service.scanGit({ url: URL, ref: null });
    expect(report.candidates).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(existsSync(join(work, 'sources'))).toBe(false);
  });

  it.skipIf(!posix)(
    'dowiazanie wychodzace poza kopie jest pominiete, a tresc spoza kopii nie trafia do skanu',
    async () => {
      const outside = join(createTempTree('acme-gitimport-outside-'), 'poza');
      mkdirSync(outside);
      writeFileSync(
        join(outside, 'SKILL.md'),
        '---\nname: acme-link\ndescription: Poza\n---\nPOZA-KOPIA\n',
      );
      writeFileSync(join(outside, 'secret.txt'), 'POZA-KOPIA-PLIK\n');
      const { fetch } = fakeFetch((copy) => {
        const skills = join(copy, 'skills');
        mkdirSync(join(skills, 'acme-ok'), { recursive: true });
        writeFileSync(
          join(skills, 'acme-ok', 'SKILL.md'),
          '---\nname: acme-ok\ndescription: Acme\n---\nTresc.\n',
        );
        symlinkSync(join(outside, 'secret.txt'), join(skills, 'acme-ok', 'notes.txt'));
        symlinkSync(outside, join(skills, 'acme-link'), 'dir');
      });
      const { service } = gitImporter(fetch);
      const report = await service.scanGit({ url: URL, ref: null });
      expect(report.candidates.map((c) => c.candidate.draft.identity.slug)).toEqual(['acme-ok']);
      expect(report.skipped.map((k) => k.reason)).toContain('symlink-outside');
      expect(JSON.stringify(report)).not.toContain('POZA-KOPIA');
      const asset = report.candidates[0]?.candidate.draft.assets ?? [];
      expect(asset).toEqual([]);
    },
  );

  it('odmowy pobierania: komunikat staly bez sciezek, a kopia i tak znika', async () => {
    const work = join(createTempTree('acme-gitimport-'), 'git-import');
    const failures: GitFetchResult[] = [
      { ok: false, kind: 'git-missing', message: `plik "git" odrzucony (${work}/bin/git: zly)` },
      { ok: false, kind: 'process', message: `pobieranie nie powiodlo sie: fatal: ${work}/x` },
      {
        ok: false,
        kind: 'process',
        message: 'pobieranie nie powiodlo sie: przekroczono limit czasu',
      },
      {
        ok: false,
        message:
          'repozytorium nie nadaje sie na plugin: dowiazanie symboliczne w repozytorium: skills/x',
      },
    ];
    const seen: unknown[] = [];
    for (const failure of failures) {
      const provider = new FsGitSourceProvider({
        workDir: work,
        fetch: () => {
          mkdirSync(join(work, 'sources', 'git', 'acme'), { recursive: true });
          return Promise.resolve(failure);
        },
      });
      const opened = await provider.open({ url: URL, ref: null });
      expect(opened.ok).toBe(false);
      if (opened.ok) throw new Error('oczekiwano odmowy');
      seen.push([opened.code, opened.message]);
      expect(opened.message).not.toContain(work);
      expect(existsSync(join(work, 'sources'))).toBe(false);
    }
    expect(seen).toEqual([
      ['git-unavailable', expect.stringContaining('git') as string],
      ['fetch-failed', expect.stringContaining('Nie udało się pobrać') as string],
      ['fetch-failed', 'Pobieranie trwało zbyt długo i zostało przerwane.'],
      [
        'rejected',
        'Repozytorium odrzucone przez kontrolę bezpieczeństwa: dowiazanie symboliczne w repozytorium: skills/x.',
      ],
    ]);
  });

  it('wyjatek z pobierania nie wycieka do uzytkownika, trafia do logu i sprzata', async () => {
    const work = join(createTempTree('acme-gitimport-'), 'git-import');
    const logged: unknown[] = [];
    const provider = new FsGitSourceProvider({
      workDir: work,
      onUnexpected: (e) => logged.push(e),
      fetch: () => Promise.reject(new Error(`EACCES ${work}/sources`)),
    });
    const opened = await provider.open({ url: URL, ref: null });
    expect(opened).toMatchObject({ ok: false, code: 'fetch-failed' });
    expect(JSON.stringify(opened)).not.toContain(work);
    expect(logged).toHaveLength(1);
  });

  it('adres, ktorego aplikacja nie pobiera, nie dociera do pobierania', async () => {
    const { fetch, calls } = fakeFetch(() => undefined);
    const { provider } = gitImporter(fetch);
    for (const url of [
      'ssh://git@example.com/acme/skills.git',
      'file:///srv/skills.git',
      'https://acme:haslo@example.com/acme/skills.git',
      'https://example.com/acme/skills.git?x=1',
    ]) {
      expect(await provider.open({ url, ref: null }), url).toMatchObject({
        ok: false,
        code: 'rejected',
      });
    }
    expect(await provider.open({ url: URL, ref: '-x' })).toMatchObject({
      ok: false,
      code: 'rejected',
    });
    expect(calls).toEqual([]);
  });

  it('purge usuwa pozostalosci po przerwanym imporcie', async () => {
    const { fetch } = fakeFetch(() => undefined);
    const { work, provider } = gitImporter(fetch);
    mkdirSync(join(work, 'sources', 'git', 'acme', COMMIT, '.claude'), { recursive: true });
    writeFileSync(join(work, 'sources', 'git', 'acme', COMMIT, '.claude', 'x.md'), 'x');
    await provider.purge();
    expect(readdirSync(work)).toEqual([]);
    await expect(provider.purge()).resolves.toBeUndefined();
  });
});

/**
 * Prawdziwe pobranie z lokalnego repozytorium utworzonego w tescie, przez `git http-backend` na petli
 * zwrotnej (adres http jest dozwolony tylko tam). Bez sieci zewnetrznej; sprawdza to, czego atrapa nie
 * pokaze: hartowanie procesu `git`, nazwy chronione (`.claude/CLAUDE.md`) w kopii i sprzatanie katalogu roboczego.
 */
describe.skipIf(process.platform === 'win32')(
  'import z lokalnego repozytorium przez git (petla zwrotna)',
  () => {
    const gitEnv = {
      PATH: process.env['PATH'] ?? '',
      HOME: '/nonexistent',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Acme',
      GIT_AUTHOR_EMAIL: 'acme@example.com',
      GIT_COMMITTER_NAME: 'Acme',
      GIT_COMMITTER_EMAIL: 'acme@example.com',
    };

    function git(cwd: string, ...args: string[]): string {
      return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
    }

    function backendPath(): string | null {
      try {
        const path = join(git(process.cwd(), '--exec-path'), 'git-http-backend');
        return existsSync(path) ? path : null;
      } catch {
        return null;
      }
    }

    function serve(root: string, backend: string): Promise<{ server: Server; port: number }> {
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const header = (name: string): string => {
          const value = req.headers[name];
          return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
        };
        const env: Record<string, string> = {
          ...gitEnv,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: '1',
          REQUEST_METHOD: req.method ?? 'GET',
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REMOTE_ADDR: '127.0.0.1',
        };
        // Naglowki zadania jako zmienne CGI; puste pola zostaja nieustawione.
        for (const [name, variable] of [
          ['content-type', 'CONTENT_TYPE'],
          ['content-length', 'CONTENT_LENGTH'],
          ['content-encoding', 'HTTP_CONTENT_ENCODING'],
          ['git-protocol', 'GIT_PROTOCOL'],
        ] as const) {
          const value = header(name);
          if (value !== '') env[variable] = value;
        }
        const child = spawn(backend, [], { env, stdio: ['pipe', 'pipe', 'ignore'] });
        child.stdin.on('error', () => undefined);
        req.pipe(child.stdin);
        const out: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
        child.on('close', () => {
          const raw = Buffer.concat(out);
          const split = raw.indexOf('\r\n\r\n');
          const headEnd = split === -1 ? raw.indexOf('\n\n') : split;
          const sepLength = split === -1 ? 2 : 4;
          if (headEnd === -1) {
            res.statusCode = 502;
            res.end();
            return;
          }
          for (const line of raw.subarray(0, headEnd).toString('utf8').split(/\r?\n/)) {
            const colon = line.indexOf(':');
            if (colon === -1) continue;
            const name = line.slice(0, colon).trim();
            const value = line.slice(colon + 1).trim();
            if (name.toLowerCase() === 'status') res.statusCode = Number.parseInt(value, 10);
            else res.setHeader(name, value);
          }
          res.end(raw.subarray(headEnd + sepLength));
        });
      });
      return new Promise((resolveListen) => {
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          resolveListen({
            server,
            port: typeof address === 'object' && address !== null ? address.port : 0,
          });
        });
      });
    }

    const backend = backendPath();

    it.skipIf(backend === null)(
      'pobiera repozytorium, skanuje je i zostawia pusty katalog roboczy',
      async () => {
        if (backend === null) return;
        const base = createTempTree('acme-gitrepo-');
        const bare = join(base, 'srv', 'acme-skills.git');
        const work = join(base, 'work');
        mkdirSync(bare, { recursive: true });
        mkdirSync(work);
        git(bare, 'init', '--bare', '--quiet');
        git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
        git(work, 'init', '--quiet');
        git(work, 'checkout', '--quiet', '-b', 'main');
        const put = (rel: string, text: string): void => {
          mkdirSync(join(work, rel, '..'), { recursive: true });
          writeFileSync(join(work, rel), text);
        };
        put(
          'skills/acme-hello/SKILL.md',
          '---\nname: acme-hello\ndescription: Acme hello\n---\nTresc hello.\n',
        );
        put(
          '.claude/agents/acme-agent.md',
          '---\nname: acme-agent\ndescription: Acme agent\n---\nTresc agenta.\n',
        );
        put('.claude/CLAUDE.md', 'Instrukcja, ktora nie wchodzi do importu.\n');
        put(
          '.claude/settings.json',
          '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo acme"}]}]}}\n',
        );
        git(work, 'add', '-A');
        git(work, 'commit', '--quiet', '-m', 'acme');
        git(work, 'push', '--quiet', bare, 'main');
        const head = git(work, 'rev-parse', 'HEAD');
        git(work, 'checkout', '--quiet', '-b', 'dev');
        put(
          'skills/acme-dev/SKILL.md',
          '---\nname: acme-dev\ndescription: Acme dev\n---\nTresc dev.\n',
        );
        git(work, 'add', '-A');
        git(work, 'commit', '--quiet', '-m', 'acme dev');
        git(work, 'push', '--quiet', bare, 'dev');

        const { server, port } = await serve(join(base, 'srv'), backend);
        try {
          const url = `http://127.0.0.1:${port}/acme-skills.git`;
          const workDir = join(base, 'userdata', 'git-import');
          const provider = new FsGitSourceProvider({ workDir });
          const lib = createHarness();
          const catalog = new FsLocationCatalog(
            { platform: process.platform, homeDir: createTempTree('acme-gitrepo-home-'), env: {} },
            { salt: new Uint8Array(32).fill(5) },
          );
          const service = new ImportService({
            catalog,
            adapters: [createClaudeCodeAdapter(), createCodexAdapter()],
            reader: new FsSourceReader((id) => catalog.resolvePath(id)),
            git: provider,
            library: lib.service,
            clock: systemClock,
          });

          const opened = await provider.open({ url, ref: null });
          if (!opened.ok)
            throw new Error(`pobranie nie powiodlo sie: ${opened.code} ${opened.message}`);
          expect(opened.source.origin).toEqual({ url, commit: head, ref: null });
          expect(opened.source.roots.map((r) => r.label).sort()).toEqual([
            '.claude/agents',
            'skills',
          ]);
          expect(existsSync(join(workDir, 'sources'))).toBe(true);
          expect(statSync(workDir).mode & 0o777).toBe(0o700);
          await opened.source.release();
          expect(readdirSync(workDir)).toEqual([]);

          const report = await service.scanGit({ url, ref: null });
          expect(report.git).toEqual({ url, ref: null, commit: head, submodules: 0 });
          expect(report.candidates.map((c) => c.candidate.draft.identity.slug).sort()).toEqual([
            'acme-agent',
            'acme-hello',
          ]);
          expect(readdirSync(workDir)).toEqual([]);

          const onDev = await service.scanGit({ url, ref: 'dev' });
          expect(onDev.candidates.map((c) => c.candidate.draft.identity.slug)).toContain(
            'acme-dev',
          );
          expect(onDev.git?.commit).not.toBe(head);

          const missing = await provider.open({ url, ref: 'nie-ma-takiego-refu' });
          expect(missing).toMatchObject({ ok: false, code: 'fetch-failed' });
          expect(JSON.stringify(missing)).not.toContain(base);
          expect(readdirSync(workDir)).toEqual([]);
        } finally {
          await new Promise<void>((done) => server.close(() => done()));
        }
      },
      120_000,
    );
  },
);
