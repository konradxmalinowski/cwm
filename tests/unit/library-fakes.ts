import type { Clock } from '../../src/core/ports/clock';
import type { ItemDraft, Sha256 } from '../../src/core/model/item';
import { createUlidGenerator } from '../../src/core/ports/id-generator';
import type {
  LibraryStore,
  SalvageResult,
  SalvagedEntry,
  StoredItemFiles,
  UnreadableEntry,
} from '../../src/core/ports/library-store';
import type { ObjectStore } from '../../src/core/ports/object-store';
import type { OperationLog, OperationRecord } from '../../src/core/ports/operation-log';
import { sha256Bytes } from '../../src/core/services/normalization/hash';
import { LibraryService } from '../../src/core/services/library/library-service';

export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  failPut: Error | null = null;
  putCalls = 0;

  readonly putHashes: Sha256[] = [];

  put(bytes: Uint8Array): Promise<Sha256> {
    this.putCalls++;
    this.putHashes.push(sha256Bytes(bytes));
    if (this.failPut !== null) return Promise.reject(this.failPut);
    const hash = sha256Bytes(bytes);
    this.objects.set(hash, new Uint8Array(bytes));
    return Promise.resolve(hash);
  }

  get(hash: Sha256): Promise<Uint8Array | null> {
    return Promise.resolve(this.objects.get(hash) ?? null);
  }

  has(hash: Sha256): Promise<boolean> {
    return Promise.resolve(this.objects.has(hash));
  }
}

export class MemoryLibraryStore implements LibraryStore {
  readonly items = new Map<string, StoredItemFiles>();
  writeCalls = 0;
  removeCalls = 0;
  failWrite: Error | null = null;
  onRemove: ((id: string) => void) | null = null;

  write(id: string, files: StoredItemFiles): Promise<void> {
    this.writeCalls++;
    if (this.failWrite !== null) return Promise.reject(this.failWrite);
    this.items.set(id, structuredClone(files));
    return Promise.resolve();
  }

  /** Elementy, dla ktorych `read` rzuca (np. za gleboka sciezka); `readItemJson` nadal dziala albo tez rzuca. */
  readonly unreadable = new Map<string, Error>();
  readonly unreadableItemJson = new Map<string, Error>();
  readCalls = 0;
  readItemJsonCalls = 0;

  read(id: string): Promise<StoredItemFiles | null> {
    this.readCalls++;
    const failure = this.unreadable.get(id);
    if (failure !== undefined) return Promise.reject(failure);
    const files = this.items.get(id);
    return Promise.resolve(files === undefined ? null : structuredClone(files));
  }

  readItemJson(id: string): Promise<Uint8Array | null> {
    this.readItemJsonCalls++;
    const failure = this.unreadableItemJson.get(id);
    if (failure !== undefined) return Promise.reject(failure);
    const files = this.items.get(id);
    return Promise.resolve(files === undefined ? null : new Uint8Array(files.itemJson));
  }

  /** Wpisy nieczytelne w `readSalvage`: wylaczaja siebie i wszystko pod soba z `entries`. */
  readonly salvageUnreadable = new Map<string, UnreadableEntry[]>();
  salvageFailure: Error | null = null;
  /** Pliki widoczne tylko w `readSalvage` (korzen elementu, snapshoty nieznanych narzedzi). */
  readonly salvageExtra = new Map<string, SalvagedEntry[]>();

  readSalvage(id: string): Promise<SalvageResult | null> {
    if (this.salvageFailure !== null) return Promise.reject(this.salvageFailure);
    const files = this.items.get(id);
    if (files === undefined) return Promise.resolve(null);
    const unreadable = this.salvageUnreadable.get(id) ?? [];
    const all: SalvagedEntry[] = [
      { relPath: 'item.json', bytes: files.itemJson },
      { relPath: 'body.md', bytes: files.body },
      ...files.assets.map((a) => ({ relPath: `assets/${a.relPath}`, bytes: a.bytes })),
      ...files.snapshotFiles.map((f) => ({
        relPath: `snapshots/${f.tool}/${f.relPath}`,
        bytes: f.bytes,
      })),
    ];
    const entries = [...all, ...(this.salvageExtra.get(id) ?? [])]
      .filter(
        (e) =>
          !unreadable.some((u) => e.relPath === u.relPath || e.relPath.startsWith(`${u.relPath}/`)),
      )
      .map((e) => ({ relPath: e.relPath, bytes: new Uint8Array(e.bytes) }));
    return Promise.resolve({ entries, unreadable: structuredClone(unreadable) });
  }

  list(): Promise<readonly string[]> {
    return Promise.resolve([...this.items.keys()]);
  }

  remove(id: string): Promise<void> {
    this.removeCalls++;
    this.onRemove?.(id);
    this.items.delete(id);
    return Promise.resolve();
  }
}

export class MemoryOperationLog implements OperationLog {
  readonly records: OperationRecord[] = [];
  fail = false;

  append(record: OperationRecord): Promise<void> {
    if (this.fail) return Promise.reject(new Error('log niedostepny'));
    this.records.push(record);
    return Promise.resolve();
  }
}

export class FakeClock implements Clock {
  constructor(private current = Date.UTC(2026, 9, 30, 12, 0, 0)) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

export function deterministicRandom(): (length: number) => Uint8Array {
  let counter = 0;
  return (length) => {
    counter++;
    return Uint8Array.from({ length }, (_, i) => (counter * 31 + i * 7) % 256);
  };
}

export function createHarness() {
  const store = new MemoryLibraryStore();
  const objects = new MemoryObjectStore();
  const log = new MemoryOperationLog();
  const clock = new FakeClock();
  const ids = createUlidGenerator(clock, deterministicRandom());
  const service = new LibraryService({ store, objects, log, ids, clock });
  return { store, objects, log, clock, ids, service };
}

export function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function dec(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

export function draft(
  overrides: Partial<ItemDraft> & { slug?: string; body?: string } = {},
): ItemDraft {
  const { slug, body, ...rest } = overrides;
  return {
    kind: 'skill',
    identity: { slug: slug ?? 'acme-review', declaredName: null, aliases: [] },
    content: {
      title: 'Acme review',
      description: 'Przeglad zmian w repozytorium acme.',
      descriptionOrigin: 'source',
      body: body ?? '# Acme review\n\nSprawdz zmiany.\n',
    },
    ...rest,
  };
}
