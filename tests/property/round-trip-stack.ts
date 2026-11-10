import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { createClaudeCodeAdapter } from '../../src/adapters/claude-code';
import { createCodexAdapter } from '../../src/adapters/codex';
import type { ItemDraft, LibraryItem, LoadedItem, ToolId } from '../../src/core/model/item';
import type { WritePlan } from '../../src/core/model/plan';
import { systemClock } from '../../src/core/ports/clock';
import type { ImportCandidate, ToolAdapter } from '../../src/core/ports/tool-adapter';
import { ExportService } from '../../src/core/services/export/export-service';
import { FsWriteGate } from '../../src/infra/fs/write-gate';
import { FsLocationCatalog } from '../../src/infra/platform/locations';
import { FsSourceReader } from '../../src/infra/source/fs-source-reader';
import { FsObjectStore } from '../../src/infra/store/object-store';
import { createExporters } from '../../src/main/bootstrap/exporters';
import { createTempTree } from '../harness/isolation';
import { NO_LINKS } from '../integration/write-gate-fixture';
import { createHarness } from '../unit/library-fakes';

/**
 * Pelna petla z ARCHITECTURE 12.1 na prawdziwym dysku: element z biblioteki, plan eksportu,
 * zapis przez WriteGate do swiezego katalogu domowego i ponowny skan adapterem.
 *
 * Materializacja jest kopia (NO_LINKS) swiadomie: dowiazanie prowadzi do userData, czyli poza
 * root narzedzia, a skan nie idzie za takim dowiazaniem (ARCHITECTURE 8.1). Petla przez link
 * zamyka sie przez probe planu, nie przez parse (tests/integration/write-gate-link.test.ts).
 */
export interface RoundTrip {
  /** Element tak, jak zapisala go biblioteka: to jest `x` z 12.1. */
  readonly stored: LoadedItem;
  readonly plan: WritePlan;
  readonly candidates: readonly ImportCandidate[];
  readonly home: string;
}

const ADAPTERS: Record<ToolId, () => ToolAdapter> = {
  'claude-code': createClaudeCodeAdapter,
  codex: createCodexAdapter,
};

export interface Stack {
  readonly home: string;
  readonly lib: ReturnType<typeof createHarness>;
  readonly exports: ExportService;
  readonly catalog: FsLocationCatalog;
  readonly reader: FsSourceReader;
  readonly adapters: readonly ToolAdapter[];
}

export function makeStack(): Stack {
  const tree = createTempTree('acme-prop-');
  const home = join(tree, 'home');
  const userData = join(tree, 'userData');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(userData, { recursive: true });

  const catalog = new FsLocationCatalog(
    { platform: process.platform, homeDir: home, env: {} },
    { salt: new Uint8Array(32).fill(7) },
  );
  const resolve = (id: string) => catalog.resolvePath(id);
  const reader = new FsSourceReader(resolve);
  const gate = new FsWriteGate({
    resolveRoot: resolve,
    userDataDir: userData,
    objects: new FsObjectStore(join(userData, 'objects')),
    linkMode: { capability: () => Promise.resolve(NO_LINKS) },
  });
  const adapters = [ADAPTERS['claude-code'](), ADAPTERS.codex()];
  const lib = createHarness();
  const exports = new ExportService({
    catalog,
    exporters: createExporters(adapters),
    reader,
    library: lib.service,
    gate,
    links: () => Promise.resolve(NO_LINKS),
    clock: systemClock,
  });
  return { home, lib, exports, catalog, reader, adapters };
}

/** Skan wszystkich istniejacych rootow narzedzia, z `finalize`, tak jak robi to import. */
export async function scanTool(stack: Stack, tool: ToolId): Promise<ImportCandidate[]> {
  const adapter = stack.adapters.find((a) => a.id === tool)!;
  const roots = (await stack.catalog.detect()).filter((r) => r.tool === tool && r.exists);
  const scans = [];
  for (const root of roots) scans.push({ root, result: await adapter.scan(root, stack.reader) });
  const results =
    adapter.finalize === undefined
      ? scans.map((s) => s.result)
      : await adapter.finalize(scans, stack.reader);
  return results.flatMap((r) => r.candidates);
}

export async function exportOnce(stack: Stack, tool: ToolId, id: string): Promise<WritePlan> {
  const report = await stack.exports.plan(tool, [id]);
  if (!report.plan.applicable) {
    throw new Error(
      `plan nieaplikowalny: ${JSON.stringify({ refusals: report.plan.refusals, conflicts: report.plan.conflicts })}`,
    );
  }
  const applied = await stack.exports.apply(report.planId, true);
  if (!applied.verified) throw new Error(`apply bez weryfikacji: ${JSON.stringify(applied)}`);
  return report.plan;
}

/** `toCanonical(parse(apply(plan(x))))` dla jednego elementu w swiezym katalogu domowym. */
export async function roundTrip(tool: ToolId, draft: ItemDraft): Promise<RoundTrip> {
  const stack = makeStack();
  const { item } = await stack.lib.service.create(draft);
  const stored = await stack.lib.service.get(item.id);
  const plan = await exportOnce(stack, tool, item.id);
  const candidates = await scanTool(stack, tool);
  return { stored, plan, candidates, home: stack.home };
}

/**
 * Poziom modelu: semantyka i rozszerzenia (ARCHITECTURE 4.1, warstwy 1 i 2). Bez `id`, wersji,
 * klasyfikacji i snapshotu, bo to stan biblioteki, nie tresc elementu. Bez `title`: zadne
 * z narzedzi nie ma pola tytulu, import wylicza go z `name`, naglowka albo nazwy zrodla
 * (src/adapters/shared/markdown-item.ts). Generatory buduja `x` z tytulem w tej postaci,
 * a osobna wlasnosc sprawdza, ze tytul wraca rowny.
 */
export interface ModelView {
  readonly kind: string;
  readonly slug: string;
  readonly declaredName: string | null;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly descriptionOrigin: string;
  readonly body: string;
  readonly attributes: LibraryItem['attributes'];
  readonly assets: readonly (readonly [string, string])[];
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

export function viewOfStored(loaded: LoadedItem): ModelView {
  const { item } = loaded;
  return {
    kind: item.kind,
    slug: item.identity.slug,
    declaredName: item.identity.declaredName,
    aliases: item.identity.aliases,
    description: item.content.description,
    descriptionOrigin: item.content.descriptionOrigin,
    body: item.content.body,
    attributes: item.attributes,
    assets: loaded.assets
      .map((a) => [a.relPath, hex(a.bytes)] as const)
      .sort((a, b) => a[0].localeCompare(b[0])),
  };
}

export function viewOfDraft(draft: ItemDraft): ModelView {
  return {
    kind: draft.kind,
    slug: draft.identity.slug,
    declaredName: draft.identity.declaredName,
    aliases: draft.identity.aliases,
    description: draft.content.description,
    descriptionOrigin: draft.content.descriptionOrigin,
    body: draft.content.body,
    attributes: draft.attributes ?? {},
    assets: (draft.assets ?? [])
      .map((a) => [a.relPath.normalize('NFC'), hex(a.bytes)] as const)
      .sort((a, b) => a[0].localeCompare(b[0])),
  };
}
