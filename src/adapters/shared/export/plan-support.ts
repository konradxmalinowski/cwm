import type { ItemId, LibraryItem, LoadedItem, RootId, ToolId } from '../../../core/model/item';
import { isIgnoredPath } from '../../../core/model/library-file-names';
import { MAX_FILE_BYTES } from '../../../core/model/library-limits';
import type {
  CompatibilityVerdict,
  PlanConflict,
  PlanOrphan,
  PlanRefusal,
  WriteAction,
  WritePlan,
  WritePlanEntry,
} from '../../../core/model/plan';
import { SourceReadError, type SourceReader } from '../../../core/ports/source-reader';
import type { DetectedRoot, ExportContext, RootKind } from '../../../core/ports/tool-adapter';
import { sha256Text } from '../../../core/services/normalization/hash';

/** Wspolne klocki planu eksportu: skladanie planu, wybor roota, odczyt stanu celu. */

export interface EntryInput {
  readonly rootId: RootId;
  readonly relPath: string;
  readonly action: WriteAction;
  readonly scope: WritePlanEntry['scope'];
  readonly itemIds: readonly ItemId[];
  readonly content?: Uint8Array | null;
  readonly files?: WritePlanEntry['files'];
  readonly previous?: Uint8Array | null;
  readonly materialization?: WritePlanEntry['materialization'];
  readonly warnings?: readonly string[];
}

export class PlanBuilder {
  private readonly entries: WritePlanEntry[] = [];
  private readonly verdicts: { itemId: ItemId; verdict: CompatibilityVerdict }[] = [];
  private readonly refusals: PlanRefusal[] = [];
  private readonly conflicts: PlanConflict[] = [];
  private readonly orphans: PlanOrphan[] = [];

  constructor(private readonly tool: ToolId) {}

  verdict(item: LibraryItem, verdict: CompatibilityVerdict): void {
    this.verdicts.push({ itemId: item.id, verdict });
  }

  refuse(item: LibraryItem, reason: string): void {
    this.refusals.push({ itemId: item.id, kind: item.kind, slug: item.identity.slug, reason });
  }

  conflict(itemIds: readonly ItemId[], relPath: string, reason: string): void {
    this.conflicts.push({ itemIds, relPath, reason });
  }

  orphan(rootId: RootId, relPath: string, reason: string): void {
    this.orphans.push({ rootId, relPath, reason });
  }

  entry(input: EntryInput): void {
    this.entries.push({
      rootId: input.rootId,
      relPath: input.relPath,
      action: input.action,
      scope: input.scope,
      itemIds: input.itemIds,
      content: input.content ?? null,
      files: input.files ?? null,
      previous: input.previous ?? null,
      materialization: input.materialization ?? null,
      warnings: input.warnings ?? [],
      recoverability: null,
    });
  }

  build(): WritePlan {
    const fingerprint = JSON.stringify({
      tool: this.tool,
      entries: this.entries.map((e) => [e.rootId, e.relPath, e.action, e.scope, e.itemIds]),
      refusals: this.refusals.map((r) => [r.itemId, r.reason]),
      conflicts: this.conflicts.map((c) => [c.itemIds, c.relPath]),
    });
    return {
      planId: `plan-${sha256Text(fingerprint + new Date().toISOString()).slice(0, 16)}`,
      tool: this.tool,
      createdAt: new Date().toISOString(),
      entries: this.entries,
      verdicts: this.verdicts,
      refusals: this.refusals,
      conflicts: this.conflicts,
      orphans: this.orphans,
      applicable: this.conflicts.length === 0,
    };
  }
}

export type RootChoice =
  | { readonly root: DetectedRoot; readonly missing?: undefined }
  | { readonly root: null; readonly missing: string };

const KIND_LABEL: Readonly<Record<RootKind, string>> = {
  skills: 'skilli',
  agents: 'agentów',
  commands: 'komend',
  rules: 'reguł',
  'global-instructions': 'instrukcji globalnej',
  hooks: 'hooków',
  'agent-registry': 'rejestru agentów (config.toml)',
};

/**
 * Pierwszy istniejacy i czytany root danego rodzaju. Brak roota to odmowa z powodem: aplikacja
 * nie tworzy drzewa narzedzia od zera (decyzja wlasciciela z 2026-11-03).
 */
export function pickRoot(ctx: ExportContext, tool: ToolId, kind: RootKind): RootChoice {
  const candidates = ctx.roots.filter((r) => r.tool === tool && r.kind === kind);
  const usable = candidates.find((r) => r.exists && r.active);
  if (usable !== undefined) return { root: usable };
  const first = candidates[0];
  if (first === undefined) {
    return {
      root: null,
      missing: `Nie wykryto lokalizacji ${KIND_LABEL[kind]} dla tego narzędzia.`,
    };
  }
  return {
    root: null,
    missing: `Lokalizacja ${KIND_LABEL[kind]} (${first.label}) nie istnieje. Aplikacja nie tworzy drzewa narzędzia od zera.`,
  };
}

/** Odczyt pliku celu; brak pliku to `null`, kazdy inny blad leci jako `TargetReadError`. */
export async function readTarget(
  reader: SourceReader,
  rootId: RootId,
  readPath: string,
): Promise<Uint8Array | null> {
  try {
    return await reader.read(rootId, readPath, MAX_FILE_BYTES);
  } catch (error) {
    if (error instanceof SourceReadError) {
      if (error.failure === 'not-found') return null;
      throw new TargetReadError(error);
    }
    throw error;
  }
}

export class TargetReadError extends Error {
  constructor(cause: SourceReadError) {
    super(`Nie udało się odczytać stanu celu (${cause.failure}).`);
    this.name = 'TargetReadError';
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

export type DirState =
  /** Brak wpisu o tej nazwie. */
  | { readonly kind: 'absent' }
  | { readonly kind: 'symlink' }
  | { readonly kind: 'other' }
  | { readonly kind: 'directory'; readonly files: ReadonlyMap<string, Uint8Array> };

/** Stan wpisu `name` w roocie katalogowym; katalog jest czytany rekurencyjnie, bez dowiazan. */
export async function readDirState(
  reader: SourceReader,
  rootId: RootId,
  rootEntries: readonly { readonly name: string; readonly type: string }[],
  name: string,
): Promise<DirState> {
  const entry = rootEntries.find((e) => e.name === name);
  if (entry === undefined) return { kind: 'absent' };
  if (entry.type === 'symlink') return { kind: 'symlink' };
  if (entry.type !== 'directory') return { kind: 'other' };
  const files = new Map<string, Uint8Array>();
  let hasLink = false;
  const walk = async (rel: string, prefix: string): Promise<void> => {
    for (const e of await reader.list(rootId, rel)) {
      if (isIgnoredPath(e.name)) continue;
      const path = `${rel}/${e.name}`;
      const shown = `${prefix}${e.name}`;
      if (e.type === 'file') files.set(shown, await reader.read(rootId, path, MAX_FILE_BYTES));
      else if (e.type === 'directory') await walk(path, `${shown}/`);
      else hasLink = true;
    }
  };
  await walk(name, '');
  // Dowiazanie wewnatrz katalogu psuje porownanie: traktujemy katalog jako rozny od oczekiwanego.
  if (hasLink) files.set('\0link', new Uint8Array());
  return { kind: 'directory', files };
}

export function dirMatches(
  state: ReadonlyMap<string, Uint8Array>,
  wanted: readonly { readonly relPath: string; readonly bytes: Uint8Array }[],
): boolean {
  if (state.size !== wanted.length) return false;
  return wanted.every((w) => {
    const have = state.get(w.relPath);
    return have !== undefined && bytesEqual(have, w.bytes);
  });
}

export function snapshotBytes(
  loaded: LoadedItem,
  tool: ToolId,
  relPath: string,
): Uint8Array | undefined {
  return loaded.snapshotFiles.find((f) => f.tool === tool && f.relPath === relPath)?.bytes;
}

export function hasSnapshot(item: LibraryItem, tool: ToolId): boolean {
  return item.source.snapshots.some((s) => s.tool === tool);
}

export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
