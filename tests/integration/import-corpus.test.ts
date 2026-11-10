import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createClaudeCodeAdapter } from '../../src/adapters/claude-code';
import { createCodexAdapter } from '../../src/adapters/codex';
import { systemClock } from '../../src/core/ports/clock';
import { ImportService } from '../../src/core/services/import/import-service';
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
