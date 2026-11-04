import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { removeTempTrees } from '../harness/isolation';

import { ALL_LINKS, entry, itemId, makeFixture, makePlan, text } from './write-gate-fixture';

afterAll(() => {
  removeTempTrees();
});

const posixOnly = it.skipIf(process.platform === 'win32');

async function run(
  f: ReturnType<typeof makeFixture>,
  entries: ReturnType<typeof entry>[],
  reverts?: string,
) {
  const probed = await f.gate.probe(makePlan(entries, reverts === undefined ? {} : { reverts }));
  return {
    probed,
    report: probed.applicable ? await f.gate.apply(probed, { planId: probed.planId }) : null,
  };
}

describe('WriteGate: akcja delete', () => {
  it('usuwa plik, robi kopie i sprzata puste katalogi do roota', async () => {
    const f = makeFixture();
    mkdirSync(join(f.skillsRoot, 'acme'), { recursive: true });
    writeFileSync(join(f.skillsRoot, 'acme', 'SKILL.md'), 'tresc\n');

    const { report } = await run(
      f,
      [
        entry({
          action: 'delete',
          content: null,
          previous: text('tresc\n'),
          itemIds: [itemId('i1')],
        }),
      ],
      'backup-x',
    );
    expect(report?.entries[0]?.outcome).toBe('written');
    expect(readdirSync(f.skillsRoot)).toEqual([]);
    expect(existsSync(f.skillsRoot)).toBe(true);

    const manifest = JSON.parse(
      readFileSync(join(f.userData, 'backups', report?.backupId ?? '', 'MANIFEST'), 'utf8'),
    ) as { entries: { before: { state: string }; after: { state: string } }[] };
    expect(manifest.entries[0]?.before.state).toBe('file');
    expect(manifest.entries[0]?.after.state).toBe('missing');
    expect(f.log[0]).toMatchObject({
      operation: 'rollback',
      reverts: 'backup-x',
      tool: 'claude-code',
    });
  });

  it('blokuje plik zmieniony od planu i nie usuwa katalogu z innymi plikami', async () => {
    const f = makeFixture();
    mkdirSync(join(f.skillsRoot, 'acme'), { recursive: true });
    writeFileSync(join(f.skillsRoot, 'acme', 'SKILL.md'), 'inna\n');
    const blocked = await f.gate.probe(
      makePlan([entry({ action: 'delete', content: null, previous: text('tresc\n') })]),
    );
    expect(blocked.applicable).toBe(false);

    writeFileSync(join(f.skillsRoot, 'acme', 'INNY.md'), 'x');
    const { report } = await run(f, [
      entry({ action: 'delete', content: null, previous: text('inna\n') }),
    ]);
    expect(report?.entries[0]?.outcome).toBe('written');
    expect(existsSync(join(f.skillsRoot, 'acme', 'INNY.md'))).toBe(true);
  });

  posixOnly('nie usuwa cudzego dowiazania', async () => {
    const f = makeFixture({ capability: ALL_LINKS });
    symlinkSync(f.outside, join(f.skillsRoot, 'acme'));
    const probed = await f.gate.probe(
      makePlan([entry({ relPath: 'acme', action: 'delete', content: null })]),
    );
    expect(probed.applicable).toBe(false);
    expect(lstatSync(join(f.skillsRoot, 'acme')).isSymbolicLink()).toBe(true);
  });

  it('brak pliku to wpis bez zmian', async () => {
    const f = makeFixture();
    const { report } = await run(f, [entry({ action: 'delete', content: null })]);
    expect(report?.entries[0]?.outcome).toBe('unchanged');
    expect(report?.backupId).toBe('');
  });
});

describe('WriteGate: akcja restore-link', () => {
  posixOnly('przywraca dowiazanie do poprzedniego celu z kopia obecnego pliku', async () => {
    const f = makeFixture();
    writeFileSync(join(f.skillsRoot, 'acme-link'), 'plik\n');
    const target = join(f.outside, 'cel.md');
    writeFileSync(target, 'cel\n');

    const { report } = await run(f, [
      entry({
        relPath: 'acme-link',
        action: 'restore-link',
        content: null,
        previous: text('plik\n'),
        linkTarget: target,
      }),
    ]);
    expect(report?.entries[0]?.outcome).toBe('written');
    expect(readlinkSync(join(f.skillsRoot, 'acme-link'))).toBe(target);
  });

  posixOnly('to samo dowiazanie to wpis bez zmian', async () => {
    const f = makeFixture();
    const target = join(f.outside, 'cel.md');
    writeFileSync(target, 'cel\n');
    symlinkSync(target, join(f.skillsRoot, 'acme-link'));
    const { report } = await run(f, [
      entry({ relPath: 'acme-link', action: 'restore-link', content: null, linkTarget: target }),
    ]);
    expect(report?.entries[0]?.outcome).toBe('unchanged');
  });

  it('odmawia wpisu bez celu albo z trescia', async () => {
    const f = makeFixture();
    const noTarget = await f.gate.probe(
      makePlan([entry({ action: 'restore-link', content: null })]),
    );
    expect(noTarget.applicable).toBe(false);
    const withContent = await f.gate.probe(
      makePlan([entry({ action: 'restore-link', linkTarget: 'x' })]),
    );
    expect(withContent.applicable).toBe(false);
  });
});
