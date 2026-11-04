import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { PlatformEnv } from '../../src/infra/platform/env';
import { FsLocationCatalog, type PathProbe } from '../../src/infra/platform/locations';
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
