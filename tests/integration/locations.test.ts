import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { PlatformEnv } from '../../src/infra/platform/env';
import { FsLocationCatalog, type PathProbe } from '../../src/infra/platform/locations';
import { FsProjectCatalog } from '../../src/infra/platform/project-locations';
import { checkChosenProjectDir } from '../../src/infra/projects/project-dir';
import { FsProjectRegistry } from '../../src/infra/projects/project-registry';
import { createTempTree, removeTempTrees } from '../harness/isolation';

afterAll(() => {
  removeTempTrees();
});

const SALT = new Uint8Array(32).fill(7);

function envFor(home: string, extra: Record<string, string> = {}): PlatformEnv {
  return { platform: process.platform, homeDir: home, env: extra };
}

function dir(path: string): void {
  mkdirSync(path, { recursive: true });
}

describe('FsLocationCatalog na podstawionym katalogu domowym', () => {
  it('zwraca tez rooty, ktorych nie ma, z exists=false', async () => {
    const home = createTempTree('acme-home-');
    dir(join(home, '.claude', 'skills'));
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# acme\n');

    const roots = await new FsLocationCatalog(envFor(home), { salt: SALT }).detect();
    const find = (label: string) => roots.find((r) => r.label === label);

    expect(find('~/.claude/skills')).toMatchObject({ tool: 'claude-code', exists: true });
    expect(find('~/.claude/CLAUDE.md')).toMatchObject({
      kind: 'global-instructions',
      exists: true,
    });
    expect(find('~/.claude/agents')?.exists).toBe(false);
    expect(find('~/.codex/skills')?.exists).toBe(false);
    expect(find('~/.agents/skills')).toMatchObject({
      tool: 'codex',
      kind: 'skills',
      exists: false,
    });
  });

  it('drugi root skilli Codeksa: raz nie istnieje, raz istnieje i jest aktywny (ADR 0024)', async () => {
    const home = createTempTree('acme-home-');
    dir(join(home, '.codex', 'skills'));
    const catalog = new FsLocationCatalog(envFor(home), { salt: SALT });

    const before = (await catalog.detect()).find((r) => r.label === '~/.agents/skills');
    expect(before).toMatchObject({ exists: false, active: false });

    dir(join(home, '.agents', 'skills'));
    const after = (await catalog.detect()).find((r) => r.label === '~/.agents/skills');
    expect(after).toMatchObject({ exists: true, active: true });
    // To samo rootId przed i po: pojawienie sie roota to zmiana stanu, nie nowy identyfikator.
    expect(after?.rootId).toBe(before?.rootId);
  });

  it('glowny root Codeksa stoi w tabeli przed drugim (pierwszenstwo przy duplikatach)', async () => {
    const home = createTempTree('acme-home-');
    const labels = (await new FsLocationCatalog(envFor(home), { salt: SALT }).detect())
      .filter((r) => r.tool === 'codex' && r.kind === 'skills')
      .map((r) => r.label);
    expect(labels).toEqual(['~/.codex/skills', '~/.agents/skills']);
  });

  it('rootId jest nieprzezroczysty, a etykieta i DTO nie zawieraja sciezki bezwzglednej', async () => {
    const home = createTempTree('acme-home-');
    dir(join(home, '.claude', 'skills'));
    const roots = await new FsLocationCatalog(envFor(home), { salt: SALT }).detect();
    const json = JSON.stringify(roots);
    expect(json).not.toContain(home);
    for (const r of roots) {
      expect(r.rootId).toMatch(/^root-[A-Za-z0-9_-]{22}$/);
      expect(r.rootId).not.toContain('claude');
    }
    expect(new Set(roots.map((r) => r.rootId)).size).toBe(roots.length);
  });

  it('mapa rootId na sciezke jest dostepna tylko przez resolvePath', async () => {
    const home = createTempTree('acme-home-');
    dir(join(home, '.claude', 'skills'));
    const catalog = new FsLocationCatalog(envFor(home), { salt: SALT });
    const root = (await catalog.detect()).find((r) => r.label === '~/.claude/skills');
    expect(catalog.resolvePath(root?.rootId ?? '')).toBe(join(home, '.claude', 'skills'));
    expect(catalog.resolvePath('root-nieznany')).toBeNull();
  });

  it('inne sole daja inne identyfikatory tego samego roota', async () => {
    const home = createTempTree('acme-home-');
    const a = await new FsLocationCatalog(envFor(home), { salt: SALT }).detect();
    const b = await new FsLocationCatalog(envFor(home), {
      salt: new Uint8Array(32).fill(9),
    }).detect();
    expect(a[0]?.rootId).not.toBe(b[0]?.rootId);
  });

  it('zmienne CLAUDE_CONFIG_DIR i CODEX_HOME przesuwaja rooty, a etykieta tego nie ukrywa', async () => {
    const home = createTempTree('acme-home-');
    const custom = createTempTree('acme-custom-');
    dir(join(custom, 'skills'));
    const catalog = new FsLocationCatalog(envFor(home, { CLAUDE_CONFIG_DIR: custom }), {
      salt: SALT,
    });
    const roots = await catalog.detect();
    const skills = roots.find((r) => r.label === '$CLAUDE_CONFIG_DIR/skills');
    expect(skills?.exists).toBe(true);
    expect(catalog.resolvePath(skills?.rootId ?? '')).toBe(join(custom, 'skills'));
    expect(roots.find((r) => r.label === '~/.codex/skills')).toBeDefined();
  });

  it('plik w miejscu katalogu nadrzednego nie liczy sie jako istniejacy root', async () => {
    const home = createTempTree('acme-home-');
    writeFileSync(join(home, '.claude'), 'plik zamiast katalogu');
    const roots = await new FsLocationCatalog(envFor(home), { salt: SALT }).detect();
    expect(roots.find((r) => r.label === '~/.claude/skills')?.exists).toBe(false);
  });

  it('katalog domowy ze spacjami i znakami spoza ASCII dziala (sciezka pozytywna)', async () => {
    const base = createTempTree('acme-home-');
    const home = join(base, 'Jan Kowalski zażółć');
    dir(join(home, '.codex', 'skills'));
    const roots = await new FsLocationCatalog(envFor(home), { salt: SALT }).detect();
    expect(roots.find((r) => r.label === '~/.codex/skills')?.exists).toBe(true);
  });
});

describe('FsLocationCatalog z podstawionym systemem', () => {
  const present = new Set<string>();
  const probe: PathProbe = (p) =>
    Promise.resolve(present.has(p) ? (p.endsWith('.md') ? 'file' : 'directory') : 'missing');

  it('Windows: sciezki z backslashem, etykiety nadal z ukosnikiem', async () => {
    present.clear();
    present.add('C:\\Users\\acme\\.agents\\skills');
    const catalog = new FsLocationCatalog(
      { platform: 'win32', homeDir: 'C:\\Users\\acme', env: {} },
      { probe, salt: SALT },
    );
    const roots = await catalog.detect();
    const second = roots.find((r) => r.label === '~/.agents/skills');
    expect(second?.exists).toBe(true);
    expect(catalog.resolvePath(second?.rootId ?? '')).toBe('C:\\Users\\acme\\.agents\\skills');
    expect(roots.find((r) => r.label === '~/.claude/skills')?.exists).toBe(false);
  });

  it('macOS i Linux daja te same etykiety co Windows', async () => {
    const labelsFor = async (platform: NodeJS.Platform, homeDir: string) =>
      (
        await new FsLocationCatalog({ platform, homeDir, env: {} }, { probe, salt: SALT }).detect()
      ).map((r) => r.label);
    const win = await labelsFor('win32', 'C:\\Users\\acme');
    expect(await labelsFor('darwin', '/Users/acme')).toEqual(win);
    expect(await labelsFor('linux', '/home/acme')).toEqual(win);
  });
});

describe('toolHomeExists', () => {
  it('~/.agents bez ~/.codex nie jest domem Codeksa', async () => {
    const home = createTempTree('acme-home-');
    dir(join(home, '.agents', 'skills'));
    const catalog = new FsLocationCatalog(envFor(home), { salt: SALT });

    expect(await catalog.toolHomeExists('codex')).toBe(false);
    expect(await catalog.toolHomeExists('claude-code')).toBe(false);
    dir(join(home, '.codex'));
    expect(await catalog.toolHomeExists('codex')).toBe(true);
  });

  it('CODEX_HOME i CLAUDE_CONFIG_DIR wskazuja katalog glowny', async () => {
    const home = createTempTree('acme-home-');
    const custom = createTempTree('acme-custom-');
    const catalog = new FsLocationCatalog(
      envFor(home, { CODEX_HOME: custom, CLAUDE_CONFIG_DIR: join(home, 'brak') }),
      { salt: SALT },
    );
    expect(await catalog.toolHomeExists('codex')).toBe(true);
    expect(await catalog.toolHomeExists('claude-code')).toBe(false);
  });

  it('plik zamiast katalogu nie liczy sie jako dom', async () => {
    const home = createTempTree('acme-home-');
    writeFileSync(join(home, '.claude'), 'x');
    const catalog = new FsLocationCatalog(envFor(home), { salt: SALT });
    expect(await catalog.toolHomeExists('claude-code')).toBe(false);
  });
});

/** Dowiazanie tam, gdzie system pozwala; na Windowsie bez uprawnien test pomija te asercje. */
function trySymlink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, 'dir');
    return true;
  } catch {
    return false;
  }
}

describe('katalog projektu z okna wyboru (ADR 0059)', () => {
  function ctx(home: string, protectedDirs: string[] = []) {
    return { platform: process.platform, home, protectedDirs, env: {} };
  }

  it('repozytorium pod katalogiem domowym przechodzi i wraca jako realpath', async () => {
    const base = createTempTree('acme-proj-');
    const home = join(base, 'home');
    const repo = join(home, 'code', 'acme-app');
    dir(repo);
    const checked = await checkChosenProjectDir(repo, ctx(home));
    expect(checked).toEqual({ ok: true, dir: realpathSync.native(repo) });
  });

  it('odrzuca katalog domowy, jego rodzica, konfiguracje narzedzia, sciezke wzgledna i brak katalogu', async () => {
    const base = createTempTree('acme-proj-');
    const home = join(base, 'home');
    const tools = join(home, '.claude');
    dir(join(tools, 'skills'));
    writeFileSync(join(home, 'plik.txt'), 'x');
    const c = ctx(home, [tools]);
    for (const chosen of [
      home,
      base,
      tools,
      join(tools, 'skills'),
      join(home, 'plik.txt'),
      join(home, 'brak'),
      'wzgledna/sciezka',
    ]) {
      expect((await checkChosenProjectDir(chosen, c)).ok, chosen).toBe(false);
    }
    // Katalog zawierajacy konfiguracje narzedzia tez nie jest projektem.
    const outside = join(base, 'repo-z-konfiguracja');
    dir(join(outside, 'cfg'));
    expect((await checkChosenProjectDir(outside, ctx(home, [join(outside, 'cfg')]))).ok).toBe(
      false,
    );
  });

  it('odrzuca katalogi systemowe i korzen dysku', async () => {
    const home = createTempTree('acme-home-');
    if (process.platform === 'win32') return;
    for (const chosen of ['/', '/usr', '/usr/lib', '/etc', '/tmp']) {
      expect((await checkChosenProjectDir(chosen, ctx(home))).ok, chosen).toBe(false);
    }
  });

  it('wybrany katalog bedacy dowiazaniem jest odrzucony', async () => {
    const base = createTempTree('acme-proj-');
    const repo = join(base, 'repo');
    dir(repo);
    const link = join(base, 'repo-link');
    if (!trySymlink(repo, link)) return;
    expect(await checkChosenProjectDir(link, ctx(join(base, 'home')))).toMatchObject({ ok: false });
  });
});

describe('rejestr i rooty projektu (ADR 0059)', () => {
  const SALT_PROMISE = Promise.resolve(SALT);

  async function project() {
    const base = createTempTree('acme-proj-');
    const repo = realpathSync.native(createTempTree('acme-repo-'));
    const file = join(base, 'projects.json');
    let n = 0;
    const registry = new FsProjectRegistry(file, {
      newId: () => `proj-${String(++n).padStart(16, '0')}`,
    });
    const added = await registry.add(repo, 'acme-app');
    return {
      base,
      repo,
      file,
      registry,
      added,
      catalog: new FsProjectCatalog(registry, SALT_PROMISE),
    };
  }

  it('rejestr zapisuje, zmienia nazwe, usuwa i odmawia duplikatu; plik nie zna innych pol', async () => {
    const t = await project();
    expect(t.added).toMatchObject({ id: 'proj-0000000000000001', name: 'acme-app', dir: t.repo });
    await expect(t.registry.add(t.repo, 'drugi')).rejects.toMatchObject({ code: 'project-exists' });
    await t.registry.rename(t.added.id, 'acme-web');
    const reread = new FsProjectRegistry(t.file);
    await reread.ready();
    expect(reread.list().map((p) => p.name)).toEqual(['acme-web']);
    await expect(t.registry.rename(t.added.id, ' ')).rejects.toMatchObject({
      code: 'invalid-name',
    });
    await t.registry.remove(t.added.id);
    expect(t.registry.list()).toEqual([]);
    await expect(t.registry.remove(t.added.id)).rejects.toMatchObject({ code: 'unknown-project' });
    expect(JSON.parse(readFileSync(t.file, 'utf8'))).toEqual({
      format: 'cwm-projects',
      version: 1,
      projects: [],
    });
  });

  it('rooty Claude Code w projekcie: istniejace i brakujace, stabilne rootId i etykiety bez sciezki', async () => {
    const t = await project();
    dir(join(t.repo, '.claude', 'skills'));
    writeFileSync(join(t.repo, 'CLAUDE.md'), '# acme\n');
    const found = await t.catalog.roots(t.added.id);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    const byLabel = new Map(found.roots.map((r) => [r.label, r]));
    expect(byLabel.get('acme-app: .claude/skills')).toMatchObject({ exists: true, kind: 'skills' });
    expect(byLabel.get('acme-app: CLAUDE.md')).toMatchObject({
      exists: true,
      kind: 'global-instructions',
    });
    expect(byLabel.get('acme-app: .claude/agents')?.exists).toBe(false);
    expect(JSON.stringify(found)).not.toContain(t.repo);

    const skills = byLabel.get('acme-app: .claude/skills');
    expect(t.catalog.resolvePath(skills?.rootId ?? '')).toBe(join(t.repo, '.claude', 'skills'));
    expect(t.catalog.ownerOf(skills?.rootId ?? '')).toEqual({
      projectId: t.added.id,
      label: 'acme-app: .claude/skills',
    });
    // Ten sam rejestr i sol po restarcie daja te same identyfikatory.
    const again = await new FsProjectCatalog(t.registry, SALT_PROMISE).roots(t.added.id);
    expect(again.ok && again.roots.map((r) => r.rootId)).toEqual(found.roots.map((r) => r.rootId));
    expect(await t.catalog.roots('proj-ffffffffffffffff')).toMatchObject({
      ok: false,
      code: 'unknown-project',
    });
  });

  it('dowiazanie w sciezce roota wylacza ten root, a zmieniony katalog projektu wylacza projekt', async () => {
    const t = await project();
    const elsewhere = createTempTree('acme-elsewhere-');
    if (!trySymlink(elsewhere, join(t.repo, '.claude'))) return;
    const found = await t.catalog.roots(t.added.id);
    expect(found.ok && found.roots.map((r) => r.label)).toEqual(['acme-app: CLAUDE.md']);

    const before = await new FsProjectCatalog(t.registry, SALT_PROMISE).roots(t.added.id);
    const claudeMd = before.ok ? before.roots[0]?.rootId : undefined;
    expect(t.catalog.resolvePath(claudeMd ?? '')).toBe(join(t.repo, 'CLAUDE.md'));

    // Katalog projektu podmieniony na dowiazanie: projekt jest niewazny, rooty nie rozwiazuja sie.
    const moved = createTempTree('acme-moved-');
    const t2 = await project();
    const ids = await t2.catalog.roots(t2.added.id);
    const anyRoot = ids.ok ? ids.roots[0]?.rootId : undefined;
    rmSync(t2.repo, { recursive: true, force: true });
    if (!trySymlink(moved, t2.repo)) return;
    expect(await t2.catalog.roots(t2.added.id)).toMatchObject({
      ok: false,
      code: 'project-invalid',
    });
    expect(t2.catalog.resolvePath(anyRoot ?? '')).toBeNull();
  });
});
