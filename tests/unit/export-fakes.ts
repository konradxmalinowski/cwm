import type { LoadedItem } from '../../src/core/model/item';
import type { ApplyReport, WritePlan, WritePlanEntry } from '../../src/core/model/plan';
import type { DetectedRoot, ExportContext, ToolExporter } from '../../src/core/ports/tool-adapter';
import type { WriteGate } from '../../src/core/ports/write-gate';
import {
  ExportService,
  type ExportServiceDeps,
} from '../../src/core/services/export/export-service';
import { FakeCatalog, NO_READER, root } from './import-fakes';
import { bytes, createHarness, draft } from './library-fakes';

export function entry(overrides: Partial<WritePlanEntry> = {}): WritePlanEntry {
  return {
    rootId: 'r-claude',
    relPath: 'acme-review/SKILL.md',
    action: 'create',
    scope: 'whole-file',
    itemIds: [],
    content: bytes('# nowa tresc\n'),
    files: null,
    previous: null,
    materialization: null,
    warnings: [],
    recoverability: null,
    ...overrides,
  };
}

export function emptyPlan(overrides: Partial<WritePlan> = {}): WritePlan {
  return {
    planId: 'z-eksportera',
    tool: 'claude-code',
    createdAt: '2026-11-03T10:00:00.000Z',
    entries: [],
    verdicts: [],
    refusals: [],
    conflicts: [],
    orphans: [],
    applicable: true,
    ...overrides,
  };
}

export class FakeExporter implements ToolExporter {
  readonly id = 'claude-code' as const;
  contexts: ExportContext[] = [];
  seen: LoadedItem[][] = [];
  constructor(public build: (items: readonly LoadedItem[]) => WritePlan) {}
  capabilities(): never {
    throw new Error('nieuzywane w tym tescie');
  }
  plan(items: readonly LoadedItem[], ctx: ExportContext): Promise<WritePlan> {
    this.contexts.push(ctx);
    this.seen.push([...items]);
    return Promise.resolve(this.build(items));
  }
}

export class FakeGate implements WriteGate {
  probes = 0;
  applies: { plan: WritePlan; planId: string }[] = [];
  /** Wpisy `blocked` ustawia test przez nadpisanie `probe`. */
  probe(plan: WritePlan): Promise<WritePlan> {
    this.probes++;
    const entries = plan.entries.map((e) => ({
      ...e,
      recoverability: { status: 'recoverable' as const, reason: null, probedAt: 'T' },
    }));
    return Promise.resolve({ ...plan, entries, applicable: plan.applicable });
  }
  apply(plan: WritePlan, approval: { readonly planId: string }): Promise<ApplyReport> {
    this.applies.push({ plan, planId: approval.planId });
    return Promise.resolve({
      planId: plan.planId,
      backupId: 'backup-1',
      entries: plan.entries.map((e) => ({
        rootId: e.rootId,
        relPath: e.relPath,
        outcome: 'written' as const,
        message: null,
      })),
      verified: true,
      rolledBack: false,
    });
  }
}

export async function exportHarness(
  options: {
    roots?: DetectedRoot[];
    build?: (items: readonly LoadedItem[]) => WritePlan;
    overrides?: Partial<ExportServiceDeps>;
  } = {},
) {
  const lib = createHarness();
  const created = await lib.service.create(draft());
  const itemId = created.item.id;
  const catalog = new FakeCatalog(options.roots ?? [root('r-claude', 'claude-code')]);
  const exporter = new FakeExporter(
    options.build ??
      ((items) =>
        emptyPlan({
          entries: [entry({ itemIds: items.map((i) => i.item.id) })],
          verdicts: items.map((i) => ({
            itemId: i.item.id,
            verdict: { level: 'full', reasons: [], lostAttributes: [], addedAttributes: [] },
          })),
        })),
  );
  const gate = new FakeGate();
  let counter = 0;
  const service = new ExportService({
    catalog,
    exporters: [exporter],
    reader: NO_READER,
    library: lib.service,
    gate,
    links: () => Promise.resolve({ fileSymlink: true, directorySymlink: false, junction: true }),
    clock: lib.clock,
    newPlanId: () => `plan-${++counter}`,
    ...options.overrides,
  });
  return { ...lib, itemId, catalog, exporter, gate, service };
}
