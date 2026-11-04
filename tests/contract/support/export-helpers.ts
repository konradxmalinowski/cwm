import { createHash } from 'node:crypto';

import type {
  ImportCandidate,
  RootKind,
  ToolAdapter,
  DetectedRoot,
} from '../../../src/core/ports/tool-adapter';
import type {
  Asset,
  ItemDraft,
  ItemId,
  LibraryItem,
  LoadedItem,
  RootId,
  Sha256,
  SourceSnapshot,
  ToolId,
} from '../../../src/core/model/item';
import type { WritePlan, WritePlanEntry } from '../../../src/core/model/plan';
import {
  SourceReadError,
  type SourceEntry,
  type SourceReader,
  type SymlinkTarget,
} from '../../../src/core/ports/source-reader';
import { normalizeToLf } from '../../../src/core/services/normalization/line-endings';

/** Klocki testow eksportu: skladanie `LoadedItem` ze szkicu i pamieciowy odczyt stanu celu. */

let counter = 0;

export function nextId(): ItemId {
  counter++;
  return `01TESTITEM${counter.toString().padStart(16, '0')}` as ItemId;
}

const sha = (bytes: Uint8Array): Sha256 =>
  createHash('sha256').update(bytes).digest('hex') as Sha256;

export function toLoaded(draft: ItemDraft, options: { keepSnapshots?: boolean } = {}): LoadedItem {
  const keep = options.keepSnapshots ?? true;
  const assets: Asset[] = (draft.assets ?? []).map((a) => ({
    relPath: a.relPath,
    bytesHash: sha(a.bytes),
    sizeBytes: a.bytes.byteLength,
  }));
  const snapshots: SourceSnapshot[] = keep
    ? (draft.source?.snapshots ?? []).map((s) => ({
        tool: s.tool,
        files: s.files.map((f) => ({
          relPath: f.relPath,
          bytesHash: sha(f.bytes),
          mode: f.mode,
          lineEnding: 'lf' as const,
        })),
        unmappedKeys: s.unmappedKeys,
      }))
    : [];
  const item: LibraryItem = {
    id: nextId(),
    kind: draft.kind,
    identity: draft.identity,
    content: draft.content,
    attributes: draft.attributes ?? {},
    assets,
    source: { snapshots, importedFrom: null },
    classification: draft.classification ?? { scope: 'private', secretFindings: [] },
    version: {
      revision: 1,
      contentHash: sha(new TextEncoder().encode(normalizeToLf(draft.content.body))),
      updatedAt: '2026-11-03T00:00:00.000Z',
    },
  };
  return {
    item,
    assets: (draft.assets ?? []).map((a) => ({ relPath: a.relPath, bytes: a.bytes })),
    snapshotFiles: keep
      ? (draft.source?.snapshots ?? []).flatMap((s) =>
          s.files.map((f) => ({ tool: s.tool, relPath: f.relPath, bytes: f.bytes })),
        )
      : [],
  };
}

export function candidatesToLoaded(
  candidates: readonly ImportCandidate[],
  options: { keepSnapshots?: boolean } = {},
): LoadedItem[] {
  return candidates.map((c) => toLoaded(c.draft, options));
}

/** Skan wszystkich rootow adaptera razem z `finalize`; zwraca kandydatow. */
export async function scanEverything(
  adapter: ToolAdapter,
  roots: readonly DetectedRoot[],
  reader: SourceReader,
): Promise<ImportCandidate[]> {
  const scans = [];
  for (const root of roots) scans.push({ root, result: await adapter.scan(root, reader) });
  const results =
    adapter.finalize === undefined
      ? scans.map((s) => s.result)
      : await adapter.finalize(scans, reader);
  return results.flatMap((r) => r.candidates);
}

export function detectedRoot(
  tool: ToolId,
  kind: RootKind,
  index: number,
  exists = true,
): DetectedRoot {
  return { rootId: `${tool}:${index}`, tool, kind, label: `~/${kind}`, exists, active: exists };
}

type DirRoot = { type: 'dir'; files: Map<string, Uint8Array> };
type FileRoot = { type: 'file'; name: string; bytes: Uint8Array | null };

/**
 * Stan celu w pamieci. Root katalogowy to mapa sciezek do bajtow, root plikowy to jeden plik.
 * Pozwala podstawic wynik planu jako stan celu bez dysku (test idempotencji).
 */
export class MemoryReader implements SourceReader {
  private readonly roots = new Map<RootId, DirRoot | FileRoot>();

  dir(rootId: RootId, files: Record<string, string | Uint8Array> = {}): this {
    const map = new Map<string, Uint8Array>();
    for (const [k, v] of Object.entries(files)) {
      map.set(k, typeof v === 'string' ? new TextEncoder().encode(v) : v);
    }
    this.roots.set(rootId, { type: 'dir', files: map });
    return this;
  }

  file(rootId: RootId, name: string, content: string | Uint8Array | null): this {
    const bytes =
      content === null || typeof content !== 'string' ? content : new TextEncoder().encode(content);
    this.roots.set(rootId, { type: 'file', name, bytes });
    return this;
  }

  private get(rootId: RootId): DirRoot | FileRoot {
    const root = this.roots.get(rootId);
    if (root === undefined) throw new SourceReadError('not-found', '', 'Nieznany root.');
    return root;
  }

  /** Nakłada wpisy planu na stan: pliki, katalogi z `files`, edycje plikow wspolnych. */
  apply(plan: WritePlan): void {
    for (const e of plan.entries) {
      if (e.action === 'unchanged') continue;
      const root = this.get(e.rootId);
      if (root.type === 'file') {
        root.bytes = e.content;
      } else if (e.files !== null) {
        for (const key of [...root.files.keys()]) {
          if (key.startsWith(`${e.relPath}/`)) root.files.delete(key);
        }
        for (const f of e.files) root.files.set(`${e.relPath}/${f.relPath}`, f.bytes);
      } else if (e.content !== null) {
        root.files.set(e.relPath, e.content);
      }
    }
  }

  list(rootId: RootId, relPath: string): Promise<readonly SourceEntry[]> {
    return Promise.resolve().then(() => {
      const root = this.get(rootId);
      if (root.type === 'file') {
        if (relPath !== '' || root.bytes === null)
          throw new SourceReadError('not-found', relPath, 'Brak.');
        return [{ name: root.name, type: 'file' as const, size: root.bytes.byteLength }];
      }
      const prefix = relPath === '' ? '' : `${relPath}/`;
      const seen = new Map<string, SourceEntry>();
      for (const [key, bytes] of root.files) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf('/');
        const name = slash === -1 ? rest : rest.slice(0, slash);
        if (!seen.has(name)) {
          seen.set(
            name,
            slash === -1
              ? { name, type: 'file', size: bytes.byteLength }
              : { name, type: 'directory', size: null },
          );
        }
      }
      if (relPath !== '' && seen.size === 0)
        throw new SourceReadError('not-found', relPath, 'Brak.');
      return [...seen.values()];
    });
  }

  read(rootId: RootId, relPath: string): Promise<Uint8Array> {
    return Promise.resolve().then(() => {
      const root = this.get(rootId);
      if (root.type === 'file') {
        if ((relPath !== '' && relPath !== root.name) || root.bytes === null) {
          throw new SourceReadError('not-found', relPath, 'Brak.');
        }
        return root.bytes;
      }
      const bytes = root.files.get(relPath);
      if (bytes === undefined) throw new SourceReadError('not-found', relPath, 'Brak.');
      return bytes;
    });
  }

  resolveSymlink(_rootId: RootId, relPath: string): Promise<SymlinkTarget> {
    return Promise.reject(new SourceReadError('not-a-file', relPath, 'Nie jest dowiazaniem.'));
  }

  mode(): Promise<number | null> {
    return Promise.resolve(null);
  }
}

export function entryFor(
  plan: WritePlan,
  rootId: RootId,
  relPath: string,
): WritePlanEntry | undefined {
  return plan.entries.find((e) => e.rootId === rootId && e.relPath === relPath);
}

export function text(bytes: Uint8Array | null | undefined): string {
  return bytes === null || bytes === undefined ? '' : new TextDecoder().decode(bytes);
}

export function enc(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
