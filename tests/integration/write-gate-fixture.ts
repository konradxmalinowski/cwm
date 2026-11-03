import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { ItemId } from '../../src/core/model/item';
import type { WritePlan, WritePlanEntry } from '../../src/core/model/plan';
import type { OperationRecord } from '../../src/core/ports/operation-log';
import type { LinkCapability } from '../../src/core/ports/write-gate';
import { FsWriteGate, type WriteGateDeps } from '../../src/infra/fs/write-gate';
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
