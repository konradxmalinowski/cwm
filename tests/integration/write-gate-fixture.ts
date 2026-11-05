import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

import { expect } from 'vitest';

import type { ItemId } from '../../src/core/model/item';
import type { WritePlan, WritePlanEntry } from '../../src/core/model/plan';
import type { OperationRecord } from '../../src/core/ports/operation-log';
import type { LinkCapability } from '../../src/core/ports/write-gate';
import { FsWriteGate, WriteGateRefusal, type WriteGateDeps } from '../../src/infra/fs/write-gate';
import { LinkCapabilityDetector } from '../../src/infra/fs/link-mode';
import { FsObjectStore } from '../../src/infra/store/object-store';
import { createTempTree } from '../harness/isolation';

export const text = (value: string): Uint8Array => new TextEncoder().encode(value);

export function entry(over: Partial<WritePlanEntry> = {}): WritePlanEntry {
  return {
    rootId: 'r-skills',
    relPath: 'acme/SKILL.md',
    action: 'create',
    scope: 'whole-file',
    itemIds: [],
    content: text('tresc\n'),
    files: null,
    previous: null,
    materialization: null,
    warnings: [],
    recoverability: null,
    ...over,
  };
}

export function makePlan(
  entries: readonly WritePlanEntry[],
  over: Partial<WritePlan> = {},
): WritePlan {
  return {
    planId: 'plan-acme-1',
    tool: 'claude-code',
    createdAt: '2026-11-03T10:00:00.000Z',
    entries,
    verdicts: [],
    refusals: [],
    conflicts: [],
    orphans: [],
    applicable: false,
    ...over,
  };
}

export const ALL_LINKS: LinkCapability = {
  fileSymlink: true,
  directorySymlink: true,
  junction: false,
};
export const NO_LINKS: LinkCapability = {
  fileSymlink: false,
  directorySymlink: false,
  junction: false,
};

export interface Fixture {
  readonly tree: string;
  readonly userData: string;
  readonly skillsRoot: string;
  readonly instructionsFile: string;
  readonly outside: string;
  readonly gate: FsWriteGate;
  readonly objects: FsObjectStore;
  readonly log: OperationRecord[];
}

export interface FixtureOptions extends Partial<
  Omit<WriteGateDeps, 'resolveRoot' | 'userDataDir'>
> {
  readonly capability?: LinkCapability;
}

export function makeFixture(options: FixtureOptions = {}): Fixture {
  const tree = createTempTree('acme-gate-');
  const userData = join(tree, 'userData');
  const skillsRoot = join(tree, 'tool', 'skills');
  const instructionsFile = join(tree, 'tool', 'CLAUDE.md');
  const outside = join(tree, 'outside');
  const missingRoot = join(tree, 'tool', 'nowy-root');
  for (const dir of [userData, skillsRoot, outside]) mkdirSync(dir, { recursive: true });

  const roots = new Map<string, string>([
    ['r-skills', skillsRoot],
    ['r-file', instructionsFile],
    ['r-missing', missingRoot],
  ]);
  const objects = new FsObjectStore(join(userData, 'objects'));
  const log: OperationRecord[] = [];
  const { capability, ...rest } = options;
  const linkMode =
    rest.linkMode ??
    (capability === undefined
      ? new LinkCapabilityDetector(userData)
      : { capability: () => Promise.resolve(capability) });

  const gate = new FsWriteGate({
    resolveRoot: (rootId) => roots.get(rootId) ?? null,
    userDataDir: userData,
    objects,
    operationLog: {
      append: (record) => {
        log.push(record);
        return Promise.resolve();
      },
    },
    ...rest,
    linkMode,
  });
  return { tree, userData, skillsRoot, instructionsFile, outside, gate, objects, log };
}

export const itemId = (value: string): ItemId => value as ItemId;

/** Odcisk calego drzewa: sciezki, rodzaje wpisow, tresc plikow, cele dowiazan i tryby. */
export function treeHash(dir: string): string {
  const hash = createHash('sha256');
  const walk = (current: string, rel: string): void => {
    for (const name of readdirSync(current).sort()) {
      const abs = join(current, name);
      const info = lstatSync(abs);
      const label = `${rel}/${name}`;
      if (info.isSymbolicLink()) {
        hash.update(`L ${label} -> ${readlinkSync(abs)}\n`);
      } else if (info.isDirectory()) {
        hash.update(`D ${label} ${(info.mode & 0o777).toString(8)}\n`);
        walk(abs, label);
      } else if (info.isFile()) {
        // Plik nieczytelny (test kryterium 8) nie da sie odczytac: bierzemy rozmiar i czas zmiany.
        let body: string;
        try {
          body = createHash('sha256').update(readFileSync(abs)).digest('hex');
        } catch {
          body = `nieczytelny:${info.size}:${info.mtimeMs}`;
        }
        hash.update(`F ${label} ${(info.mode & 0o777).toString(8)} ${body}\n`);
      } else {
        hash.update(`O ${label}\n`);
      }
    }
  };
  walk(dir, '');
  return hash.digest('hex');
}

/** Plan z jednym zdrowym wpisem i jednym zablokowanym; `forged` udaje, ze brama go zatwierdzila. */
export async function expectNoBytesWritten(f: Fixture, blockedPlan: WritePlan): Promise<void> {
  const probed = await f.gate.probe(blockedPlan);
  expect(probed.applicable).toBe(false);
  expect(probed.entries.some((e) => e.recoverability?.status === 'blocked')).toBe(true);

  const before = treeHash(f.tree);

  await expect(f.gate.apply(probed, { planId: probed.planId })).rejects.toBeInstanceOf(
    WriteGateRefusal,
  );
  expect(treeHash(f.tree)).toBe(before);

  // Obrona w glab: podrobiona flaga applicable nie zmienia wyniku, bo apply liczy stan od nowa.
  const forged: WritePlan = { ...probed, applicable: true };
  await expect(f.gate.apply(forged, { planId: forged.planId })).rejects.toBeInstanceOf(
    WriteGateRefusal,
  );
  expect(treeHash(f.tree)).toBe(before);
}
