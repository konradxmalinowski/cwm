import {
  TOOL_IDS,
  type Asset,
  AssetFile,
  ItemDraft,
  ItemId,
  ItemKind,
  LibraryItem,
  LoadedItem,
  Sha256,
  SnapshotFile,
  SourceSnapshot,
  Timestamp,
  type ToolId,
} from '../../model/item';
import { MAX_OBJECT_BYTES } from '../../model/library-limits';
import {
  LibraryError,
  LibraryOperationError,
  LibraryValidationError,
  validationError,
  type LibraryWarning,
  type ValidationIssue,
  type ValidationReason,
} from '../../model/library-errors';
import { isIgnoredPath } from '../../model/library-file-names';
import type { Clock } from '../../ports/clock';
import { isItemId, type IdGenerator } from '../../ports/id-generator';
import type { LibraryStore, SalvageResult, StoredItemFiles } from '../../ports/library-store';
import {
  STORE_FAILURE_TEXT,
  failureCodeOf,
  type StoreFailureCode,
} from '../../ports/store-failure';
import type { LibraryIndex, LibraryIndexEntry } from '../../ports/library-index';
import type { ObjectStore } from '../../ports/object-store';
import type { OperationLog, OperationRecord, OperationState } from '../../ports/operation-log';
import { sha256Bytes, sha256Text } from '../normalization/hash';
import { detectLineEnding, normalizeToLf } from '../normalization/line-endings';
import {
  decodeUtf8,
  decodeItemJson,
  decodeStoredItem,
  decodeVersionRecord,
  encodeItemJson,
  encodeVersionRecord,
  inspectStoredItem,
  loadedFromInspected,
  metaToItem,
  salvageManifest,
  type FileMismatch,
  type InspectedItem,
} from './item-codec';
import {
  collisionKey,
  findSlugCollision,
  parseItemMeta,
  slugDeclaredNameWarning,
  checkSizeLimits,
  type SizeCheckInput,
  validateAssetPaths,
  validateSlug,
  type ItemMeta,
  type SlugEntry,
} from './validate';

export interface LibraryServiceDeps {
  readonly store: LibraryStore;
  readonly objects: ObjectStore;
  readonly log: OperationLog;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  /**
   * Indeks wyszukiwania i slugow. Dostep leniwy: `null`, gdy indeks jest niedostepny (odmowa
   * startu) albo wlasnie jest wymieniany. Brak tej zaleznosci oznacza prace wylacznie na plikach.
   */
  readonly index?: () => LibraryIndex | null;
}

/** Wynik wypelniania indeksu z plikow. `failed` to elementy, ktorych nie dalo sie wpisac do indeksu. */
export interface IndexSyncReport {
  readonly status: 'unavailable' | 'current' | 'rebuilt';
  /** Elementy poprawne wpisane do indeksu. */
  readonly restored: number;
  readonly failed: readonly { readonly id: string; readonly reason: string }[];
}

export interface IndexSyncOptions {
  /** Wypelnia indeks niezaleznie od liczby elementow (po odbudowie albo recznej odbudowie). */
  readonly force?: boolean;
  /** Wymiana pliku indeksu (kwarantanna i nowy indeks) wewnatrz kolejki, miedzy zapisami. */
  readonly prepare?: () => void | Promise<void>;
}

export interface MutationResult {
  readonly item: LibraryItem;
  readonly warnings: readonly LibraryWarning[];
}

export interface ListProblem {
  /** Nazwa katalogu elementu, nie sciezka. */
  readonly id: string;
  readonly reason: ValidationReason | LibraryError['reason'];
  readonly message: string;
}

/** Jeden zepsuty element nie ukrywa pozostalych (ADR 0029: raportuj, czego nie wczytano). */
export interface ListResult {
  readonly items: readonly LibraryItem[];
  /** Elementy, ktorych `item.json` sie parsuje, a pliki nie zgadzaja sie z jego hashami. */
  readonly inconsistent: readonly InconsistentItem[];
  readonly problems: readonly ListProblem[];
}

/** Dane do pokazania w UI przy elemencie niespojnym. Akcje naprawy: `adoptDisk`, `restoreVersion`, usuniecie. */
export interface InconsistentItem {
  readonly id: ItemId;
  readonly slug: string;
  readonly kind: ItemKind;
  readonly files: readonly FileMismatch[];
  /** Metadane z `item.json`, potrzebne indeksowi; tresc elementu nie jest wiarygodna. */
  readonly meta: {
    readonly title: string;
    readonly description: string;
    readonly revision: number;
    readonly contentHash: Sha256;
    readonly updatedAt: Timestamp;
  };
}

/**
 * Plan usuniecia (ADR 0031). `revision` i `contentHash` sa odciskiem stanu: `applyDelete`
 * odmawia, jesli element zmienil sie od zbudowania planu. Ksztalt `recoverability` jest
 * zgodny z ADR 0028, zeby Etap 5 mogl go przejac bez zmian.
 */
export interface DeletePlan {
  readonly itemId: ItemId;
  /** `null`, gdy `item.json` jest nieczytelny: taki element tez da sie usunac. */
  readonly kind: ItemKind | null;
  readonly slug: string | null;
  readonly title: string | null;
  /** Dla elementu niespojnego opisuja `item.json`, nie dysk; stan dysku opisuje `stateHash`. */
  readonly revision: number;
  readonly contentHash: Sha256;
  readonly consistent: boolean;
  /** Hash manifestu surowych plikow. Zmiana jakiegokolwiek bajtu na dysku przeterminowuje plan. */
  readonly stateHash: Sha256;
  readonly assetCount: number;
  readonly snapshotFileCount: number;
  readonly recoverability: {
    /** `partial`: kopia obejmie tylko to, co da sie odczytac; `unrecoverable` mowi, czego nie odzyska. */
    readonly status: 'recoverable' | 'partial' | 'blocked';
    readonly reason: string | null;
    readonly probedAt: Timestamp;
  };
  /** Pliki, ktorych usuniecie nie zostawi kopii. Puste poza planem `partial`. */
  readonly unrecoverable: readonly UnrecoverableEntry[];
  readonly applicable: boolean;
}

export interface UnrecoverableEntry {
  /** Wzgledem katalogu elementu (`assets/...`), nigdy sciezka bezwzgledna. */
  readonly relPath: string;
  readonly failure: StoreFailureCode;
}

export interface ApplyDeleteOptions {
  /** Wymagane dla planu `partial`: uzytkownik wie, ze czesci plikow nie da sie odzyskac. */
  readonly acknowledgeUnrecoverable?: boolean;
}

export interface DeleteResult {
  readonly warnings: readonly LibraryWarning[];
}

function failureSuffix(cause: unknown): { failure: StoreFailureCode; text: string } {
  const failure = failureCodeOf(cause);
  return {
    failure,
    text: failure === 'unknown' ? '' : ` Przyczyna: ${STORE_FAILURE_TEXT[failure]}.`,
  };
}

function backupFailed(cause: unknown): LibraryOperationError {
  const { failure, text } = failureSuffix(cause);
  return new LibraryOperationError(
    'backup-failed',
    'Nie udało się zapisać poprzedniej wersji elementu w historii, więc zmiana nie została wykonana. ' +
      `Element na dysku jest bez zmian.${text}`,
    cause,
    failure,
  );
}

function storeFailed(action: string, cause: unknown): LibraryOperationError {
  const { failure, text } = failureSuffix(cause);
  return new LibraryOperationError(
    'store-failed',
    `Nie udało się ${action} elementu na dysku.${text}`,
    cause,
    failure,
  );
}

function notFound(): LibraryOperationError {
  return new LibraryOperationError('not-found', 'Nie ma takiego elementu w bibliotece.');
}

const MIB = 1024 * 1024;

const PERMANENT_FAILURES: ReadonlySet<StoreFailureCode> = new Set([
  'symlink',
  'permission-denied',
  'path-too-deep',
  'not-a-file',
  'too-large',
  'invalid-path',
]);

export class LibraryService {
  private queue: Promise<unknown> = Promise.resolve();
  /** Hashe juz wlozone do ObjectStore w biezacej operacji: kazdy trafia tam najwyzej raz. */
  private readonly putSeen = new Set<Sha256>();
  /** Czy indeks odpowiada plikom na tyle, by czytac z niego slugi i wyniki wyszukiwania. */
  private indexTrusted = false;

  constructor(private readonly deps: LibraryServiceDeps) {}

  /** Zapisy ida po kolei: sprawdzenie kolizji i zapis nie moga sie przeplatac z innym zapisem. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const wrapped = (): Promise<T> => {
      this.putSeen.clear();
      return task();
    };
    const run = this.queue.then(wrapped, wrapped);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async create(draft: ItemDraft): Promise<MutationResult> {
    return this.exclusive(async () => {
      const id = this.deps.ids.next();
      await this.requireFreeId(id);
      const built = await this.build(draft, { id, previous: null });
      await this.commit(built);

      const indexWarnings = this.updateIndex((index) => index.upsert(entryOf(built.loaded.item)));
      const warnings = await this.record({
        operation: 'create',
        ...identityOf(built.loaded.item),
        before: null,
        after: built.encoded.state,
      });
      return {
        item: built.loaded.item,
        warnings: [...built.warnings, ...indexWarnings, ...warnings],
      };
    });
  }

  async update(id: string, draft: ItemDraft): Promise<MutationResult> {
    return this.exclusive(async () => {
      const tree = await this.readCompleteTree(id);
      const previous = decodeStoredItem(tree.files, id);
      const built = await this.build(draft, { id: previous.item.id, previous });

      // Poprzednia wersja musi byc w ObjectStore, zanim ktorykolwiek plik elementu zostanie ruszony (ADR 0028).
      const before = await this.archiveAll(tree.salvage, previous, null);
      await this.commit(built);

      const indexWarnings = this.updateIndex((index) => index.upsert(entryOf(built.loaded.item)));
      const warnings = await this.record({
        operation: 'update',
        ...identityOf(built.loaded.item),
        before,
        after: built.encoded.state,
      });
      return {
        item: built.loaded.item,
        warnings: [...built.warnings, ...indexWarnings, ...warnings],
      };
    });
  }

  /**
   * Naprawa niespojnego elementu: bajty z dysku stają sie nowa rewizja (pliki sa prawda, ADR 0014).
   * Pliki spoza `item.json` na dysku (assety) sa przyjmowane, wymienione w nim a brakujace znikaja.
   */
  async adoptDisk(id: string): Promise<MutationResult> {
    return this.exclusive(async () => {
      const tree = await this.readCompleteTree(id);
      const files = tree.files;
      const inspected = this.requireInconsistent(files, id);
      if (inspected.body === null) {
        throw validationError(
          'integrity-mismatch',
          'Plik body.md nie jest poprawnym tekstem UTF-8, więc nie można przyjąć go jako nowej wersji. ' +
            'Zapisz go w UTF-8, przywróć poprzednią wersję albo usuń element.',
        );
      }
      const built = await this.build(draftFromDisk(inspected.meta, files, inspected.body), {
        id: inspected.meta.id,
        previous: stubOf(inspected.meta),
      });

      const before = await this.archiveSalvage(tree.salvage, inspected.meta);
      await this.commit(built);

      const indexWarnings = this.updateIndex((index) => index.upsert(entryOf(built.loaded.item)));
      const warnings = await this.record({
        operation: 'adopt-disk',
        ...identityOf(built.loaded.item),
        before,
        after: built.encoded.state,
      });
      return {
        item: built.loaded.item,
        warnings: [...built.warnings, ...indexWarnings, ...warnings],
      };
    });
  }

  /** Naprawa niespojnego elementu: wraca wersja wskazana przez `item.json`, o ile jej rekord jest w `objects/`. */
  async restoreVersion(id: string): Promise<MutationResult> {
    return this.exclusive(async () => {
      const tree = await this.readCompleteTree(id);
      const inspected = this.requireInconsistent(tree.files, id);
      const restored = await this.fetchVersion(inspected.meta);
      const built = await this.build(restored, {
        id: inspected.meta.id,
        previous: stubOf(inspected.meta),
      });

      const before = await this.archiveSalvage(tree.salvage, inspected.meta);
      await this.commit(built);

      const indexWarnings = this.updateIndex((index) => index.upsert(entryOf(built.loaded.item)));
      const warnings = await this.record({
        operation: 'restore',
        ...identityOf(built.loaded.item),
        before,
        after: built.encoded.state,
      });
      return {
        item: built.loaded.item,
        warnings: [...built.warnings, ...indexWarnings, ...warnings],
      };
    });
  }

  /** Odczyty stoja w tej samej kolejce co zapisy, zeby nie zobaczyc polowy zapisu jako niespojnosci. */
  async get(id: string): Promise<LoadedItem> {
    return this.exclusive(() => this.load(id));
  }

  async list(): Promise<ListResult> {
    return this.exclusive(() => this.listUnlocked());
  }

  /**
   * Identyfikatory pasujace do zapytania z indeksu, od najlepszego trafienia. `null` oznacza,
   * ze indeks nie jest gotowy albo aktualny i wolajacy ma przeszukac pliki sam.
   */
  search(query: string, kind?: ItemKind): readonly ItemId[] | null {
    const index = this.trustedIndex();
    if (index === null) return null;
    try {
      return index.search(query, kind);
    } catch {
      this.indexTrusted = false;
      return null;
    }
  }

  /**
   * Wypelnia indeks z plikow (ADR 0014), gdy jest swiezy albo liczba elementow sie nie zgadza.
   * Idzie w kolejce zapisow, wiec zaden zapis nie wchodzi w srodku. Elementy, ktorych nie da sie
   * wczytac, wracaja w `failed` z powodem; niespojne trafiaja do indeksu tylko po nazwie.
   */
  async syncIndex(options: IndexSyncOptions = {}): Promise<IndexSyncReport> {
    return this.exclusive(async () => {
      if (options.prepare !== undefined) {
        this.indexTrusted = false;
        await options.prepare();
      }
      const index = this.deps.index?.() ?? null;
      if (index === null) {
        this.indexTrusted = false;
        return { status: 'unavailable', restored: 0, failed: [] };
      }

      const names = await this.listNames();
      try {
        if (options.force !== true && index.count() === names.length) {
          this.indexTrusted = true;
          return { status: 'current', restored: index.count(), failed: [] };
        }

        const listed = await this.listUnlocked();
        const entries: LibraryIndexEntry[] = [
          ...listed.items.map(entryOf),
          ...listed.inconsistent.map(inconsistentEntryOf),
        ];
        const { rejected } = index.replaceAll(entries);
        this.indexTrusted = true;

        const rejectedIds = new Set<string>(rejected.map((r) => r.id));
        const failed = [
          ...listed.problems.map((p) => ({ id: p.id, reason: p.message })),
          ...listed.inconsistent
            .filter((i) => !rejectedIds.has(i.id))
            .map((i) => ({
              id: i.id,
              reason:
                'pliki nie zgadzaja sie z item.json; element nie jest przeszukiwany, ale jego nazwa nadal blokuje kolizje',
            })),
          ...rejected.map((r) => ({ id: r.id, reason: r.reason })),
        ];
        return {
          status: 'rebuilt',
          restored: listed.items.filter((i) => !rejectedIds.has(i.id)).length,
          failed,
        };
      } catch (error: unknown) {
        this.indexTrusted = false;
        throw error;
      }
    });
  }

  private trustedIndex(): LibraryIndex | null {
    if (!this.indexTrusted) return null;
    return this.deps.index?.() ?? null;
  }

  /**
   * Zapis do indeksu po zapisie plikow (ADR 0014). Awaria nie cofa zapisu: element jest na dysku,
   * a indeks przestaje byc zaufany, wiec slugi i wyszukiwanie wracaja do plikow.
   */
  private updateIndex(change: (index: LibraryIndex) => void): LibraryWarning[] {
    const index = this.deps.index?.() ?? null;
    if (index === null) {
      this.indexTrusted = false;
      return [];
    }
    try {
      change(index);
      return [];
    } catch {
      this.indexTrusted = false;
      return [
        {
          code: 'index-update-failed',
          message:
            'Operacja została wykonana, ale nie udało się zaktualizować indeksu wyszukiwania. ' +
            'Wyszukiwanie korzysta z plików do czasu odbudowy indeksu w Diagnostyce.',
        },
      ];
    }
  }

  private async listUnlocked(): Promise<ListResult> {
    const names = await this.listNames();
    const items: LibraryItem[] = [];
    const inconsistent: InconsistentItem[] = [];
    const problems: ListProblem[] = [];

    for (const name of names) {
      if (!isItemId(name)) {
        problems.push({
          id: name,
          reason: 'id-mismatch',
          message: 'Nazwa katalogu nie jest poprawnym identyfikatorem elementu.',
        });
        continue;
      }
      try {
        const files = await this.readFiles(name);
        const inspected = inspectStoredItem(files, name);
        if (inspected.mismatches.length > 0) {
          inconsistent.push({
            id: inspected.meta.id,
            slug: inspected.meta.identity.slug,
            kind: inspected.meta.kind,
            files: inspected.mismatches,
            meta: {
              title: inspected.meta.content.title,
              description: inspected.meta.content.description,
              revision: inspected.meta.version.revision,
              contentHash: inspected.meta.version.contentHash,
              updatedAt: inspected.meta.version.updatedAt,
            },
          });
        } else {
          items.push(loadedFromInspected(inspected, files).item);
        }
      } catch (error: unknown) {
        if (!(error instanceof LibraryError)) throw error;
        problems.push({ id: name, reason: error.reason, message: error.message });
      }
    }

    items.sort(
      (a, b) =>
        a.identity.slug.toLowerCase().localeCompare(b.identity.slug.toLowerCase()) ||
        a.id.localeCompare(b.id),
    );
    return { items, inconsistent, problems };
  }

  async planDelete(id: string): Promise<DeletePlan> {
    return this.exclusive(async () => {
      let tree: DiskTree;
      try {
        tree = await this.readTree(id);
      } catch (error: unknown) {
        if (error instanceof LibraryOperationError && error.reason === 'store-failed') {
          return this.unreadablePlan(id, error);
        }
        throw error;
      }
      // Cos w drzewie nie czyta sie: kopia obejmie tylko to, co sie da (ADR 0028), a utrata jest w planie wprost.
      if (tree.salvage.unreadable.length > 0) return this.partialPlan(id, tree.salvage);

      const { files, salvage } = tree;
      const inspected = tryInspect(files, id);
      const consistent = inspected !== null && inspected.mismatches.length === 0;
      const loaded = consistent ? loadedFromInspected(inspected, files) : null;

      let reason: string | null = null;
      try {
        await this.archiveAll(salvage, loaded, inspected?.meta ?? null);
      } catch (error: unknown) {
        if (!(error instanceof LibraryOperationError)) throw error;
        reason = error.message;
      }

      const meta = inspected?.meta ?? null;
      return {
        itemId: id as ItemId,
        kind: meta?.kind ?? null,
        slug: meta?.identity.slug ?? null,
        title: meta?.content.title ?? null,
        revision: meta?.version.revision ?? 0,
        contentHash: meta?.version.contentHash ?? sha256Bytes(files.body),
        consistent,
        stateHash: salvageStateHash(salvage),
        assetCount: files.assets.length,
        snapshotFileCount: files.snapshotFiles.length,
        recoverability: {
          status: reason === null ? 'recoverable' : 'blocked',
          reason,
          probedAt: this.deps.clock.now().toISOString(),
        },
        unrecoverable: [],
        applicable: reason === null,
      };
    });
  }

  private async partialPlan(id: string, salvage: SalvageResult): Promise<DeletePlan> {
    const meta = metaFromSalvage(salvage, id);
    let reason: string | null = null;
    try {
      await this.archiveSalvage(salvage, meta);
    } catch (error: unknown) {
      if (!(error instanceof LibraryOperationError)) throw error;
      reason = error.message;
    }

    const unrecoverable = salvage.unreadable.map((u) => ({
      relPath: u.relPath,
      failure: u.failure,
    }));
    const body = salvage.entries.find((e) => e.relPath === 'body.md');
    return {
      itemId: id as ItemId,
      kind: meta?.kind ?? null,
      slug: meta?.identity.slug ?? null,
      title: meta?.content.title ?? null,
      revision: meta?.version.revision ?? 0,
      contentHash: meta?.version.contentHash ?? sha256Bytes(body?.bytes ?? new Uint8Array()),
      consistent: false,
      stateHash: salvageStateHash(salvage),
      assetCount: salvage.entries.filter((e) => e.relPath.startsWith('assets/')).length,
      snapshotFileCount: salvage.entries.filter((e) => e.relPath.startsWith('snapshots/')).length,
      recoverability: {
        status: reason !== null ? 'blocked' : 'partial',
        reason: reason ?? partialReason(unrecoverable),
        probedAt: this.deps.clock.now().toISOString(),
      },
      unrecoverable,
      applicable: reason === null,
    };
  }

  /**
   * Archiwum calego drzewa elementu z `readSalvage` (SEC-002): takze pliki w korzeniu, snapshoty
   * nieznanych narzedzi i wszystko, co zamiana katalogow przy `write` albo `remove` skasuje. Manifest jest stanem "przed" w logu.
   */
  private async archiveSalvage(
    salvage: SalvageResult,
    meta: ItemMeta | null,
  ): Promise<OperationState> {
    for (const entry of salvage.entries) await this.putVerified(entry.bytes);
    const body = salvage.entries.find((e) => e.relPath === 'body.md');
    const text = body === undefined ? '' : decodeUtf8(body.bytes, true);
    return {
      revision: meta?.version.revision ?? 0,
      contentHash: text === null ? sha256Bytes(body!.bytes) : sha256Text(normalizeToLf(text)),
      versionHash: await this.putVerified(salvageManifest(salvage, { includeJunk: true })),
    };
  }

  private unreadablePlan(id: string, error: LibraryOperationError): DeletePlan {
    return {
      itemId: id as ItemId,
      kind: null,
      slug: null,
      title: null,
      revision: 0,
      contentHash: sha256Text(''),
      consistent: false,
      stateHash: sha256Text(''),
      assetCount: 0,
      snapshotFileCount: 0,
      recoverability: {
        status: 'blocked',
        reason: `Nie da się odczytać plików elementu, więc nie można zabezpieczyć jego kopii. ${error.message}`,
        probedAt: this.deps.clock.now().toISOString(),
      },
      unrecoverable: [],
      applicable: false,
    };
  }

  /**
   * Plan przychodzi od wywolujacego (renderer przez IPC), wiec jest niezaufany: z planu bierzemy tylko
   * `itemId` i odcisk stanu. Status, nieczytelne wpisy i potrzebe potwierdzenia wyznacza ponowny odczyt dysku.
   */
  async applyDelete(plan: DeletePlan, options: ApplyDeleteOptions = {}): Promise<DeleteResult> {
    return this.exclusive(async () => {
      if (!plan.applicable) {
        throw new LibraryOperationError(
          'plan-blocked',
          'Usunięcie jest zablokowane: nie da się zabezpieczyć kopii elementu.',
        );
      }

      const { files, salvage } = await this.readTree(plan.itemId);
      const stale = new LibraryOperationError(
        'stale-plan',
        'Element zmienił się od chwili przygotowania usunięcia. Przygotuj plan ponownie.',
      );
      // Przy niespojnosci revision i contentHash nie opisuja dysku, wiec o przeterminowaniu decydujaja bajty.
      if (salvageStateHash(salvage) !== plan.stateHash) throw stale;

      if (salvage.unreadable.length > 0 && options.acknowledgeUnrecoverable !== true) {
        throw new LibraryOperationError(
          'unrecoverable-unacknowledged',
          `${partialReason(salvage.unreadable)} Potwierdź utratę tych plików, żeby usunąć element.`,
        );
      }

      const inspected = tryInspect(files, plan.itemId);
      const consistent =
        inspected !== null && inspected.mismatches.length === 0 && salvage.unreadable.length === 0;
      if (consistent) {
        const { version } = inspected.meta;
        if (version.revision !== plan.revision || version.contentHash !== plan.contentHash) {
          throw stale;
        }
      }

      const before = await this.archiveAll(
        salvage,
        consistent ? loadedFromInspected(inspected, files) : null,
        inspected?.meta ?? null,
      );
      try {
        await this.deps.store.remove(plan.itemId);
      } catch (error: unknown) {
        throw storeFailed('usunąć', error);
      }

      const indexWarnings = this.updateIndex((index) => index.remove(plan.itemId));
      const warnings = await this.record({
        operation: 'delete',
        itemId: plan.itemId,
        kind: inspected?.meta.kind ?? null,
        slug: inspected?.meta.identity.slug ?? null,
        before,
        after: null,
      });
      return { warnings: [...indexWarnings, ...warnings] };
    });
  }

  // --- wnetrze ---

  /** Zapis zastepuje caly katalog elementu, wiec zajete `id` nie moze dojsc do `store.write` (SEC-009). */
  private async requireFreeId(id: ItemId): Promise<void> {
    if ((await this.listNames()).includes(id)) {
      throw new LibraryOperationError(
        'id-collision',
        'Wylosowany identyfikator elementu jest już zajęty. Spróbuj ponownie.',
      );
    }
  }

  private async listNames(): Promise<readonly string[]> {
    try {
      return await this.deps.store.list();
    } catch (error: unknown) {
      throw storeFailed('odczytać listę', error);
    }
  }

  /** `id` trafia do portu jako nazwa katalogu, wiec nie-ULID nie dociera dalej. */
  private async readFiles(id: string): Promise<StoredItemFiles> {
    if (!isItemId(id)) throw notFound();
    let files: StoredItemFiles | null;
    try {
      files = await this.deps.store.read(id);
    } catch (error: unknown) {
      throw storeFailed('odczytać', error);
    }
    if (files === null) throw notFound();
    return files;
  }

  /** Cale drzewo elementu z `readSalvage` plus `StoredItemFiles` wyprowadzone z tych samych bajtow. */
  private async readTree(id: string): Promise<DiskTree> {
    if (!isItemId(id)) throw notFound();
    let salvage: SalvageResult | null;
    try {
      salvage = await this.deps.store.readSalvage(id);
    } catch (error: unknown) {
      throw storeFailed('odczytać', error);
    }
    if (salvage === null) throw notFound();
    return { salvage, files: filesFromSalvage(salvage) };
  }

  /** Operacja nadpisujaca nie zachodzi, gdy czesci katalogu nie da sie skopiowac (jak plan `partial`). */
  private async readCompleteTree(id: string): Promise<DiskTree> {
    const tree = await this.readTree(id);
    if (tree.salvage.unreadable.length > 0) {
      throw new LibraryOperationError(
        'backup-failed',
        'Nie można zabezpieczyć kopii wszystkich plików elementu, więc zmiana nie została wykonana. ' +
          partialReason(tree.salvage.unreadable),
        undefined,
        tree.salvage.unreadable[0]?.failure,
      );
    }
    return tree;
  }

  private async load(id: string): Promise<LoadedItem> {
    return decodeStoredItem(await this.readFiles(id), id);
  }

  private requireInconsistent(files: StoredItemFiles, id: string): InspectedItem {
    const inspected = inspectStoredItem(files, id);
    if (inspected.mismatches.length === 0) {
      throw new LibraryOperationError(
        'not-inconsistent',
        'Pliki elementu zgadzają się z item.json, więc nie ma czego naprawiać.',
      );
    }
    return inspected;
  }

  /** Odtwarza draft wersji z rekordu w `objects/`; brak rekordu lub jego plikow to rozpoznany blad. */
  private async fetchVersion(meta: ItemMeta): Promise<ItemDraft> {
    const missing = (what: string, cause?: unknown): LibraryOperationError =>
      new LibraryOperationError(
        'version-record-missing',
        `Nie można przywrócić poprzedniej wersji: ${what} nie ma w historii. ` +
          `Użyj zapisu stanu z dysku albo usuń element.`,
        cause,
      );
    const fetch = async (hash: Sha256, what: string): Promise<Uint8Array> => {
      let bytes: Uint8Array | null;
      try {
        bytes = await this.deps.objects.get(hash);
      } catch (error: unknown) {
        throw missing(what, error);
      }
      if (bytes === null || sha256Bytes(bytes) !== hash) throw missing(what);
      return bytes;
    };

    if (meta.versionRecordHash === null) {
      throw missing('wskazania na zapisaną wersję (element zapisano bez niego)');
    }
    const record = decodeVersionRecord(
      await fetch(meta.versionRecordHash, 'rekordu wersji'),
      meta.id,
    );
    const assets = [];
    for (const asset of record.meta.assets) {
      assets.push({
        relPath: asset.relPath,
        bytes: await fetch(asset.bytesHash, `pliku assets/${asset.relPath}`),
      });
    }
    const snapshots = [];
    for (const snapshot of record.meta.source.snapshots) {
      const snapshotFiles = [];
      for (const file of snapshot.files) {
        snapshotFiles.push({
          relPath: file.relPath,
          mode: file.mode,
          bytes: await fetch(file.bytesHash, `pliku snapshots/${snapshot.tool}/${file.relPath}`),
        });
      }
      snapshots.push({
        tool: snapshot.tool,
        files: snapshotFiles,
        unmappedKeys: snapshot.unmappedKeys,
      });
    }
    return {
      kind: record.meta.kind,
      identity: record.meta.identity,
      content: { ...record.meta.content, body: record.body },
      attributes: record.meta.attributes,
      classification: record.meta.classification,
      assets,
      source: { snapshots, importedFrom: record.meta.source.importedFrom },
    };
  }

  private async existingSlugs(): Promise<SlugEntry[]> {
    const index = this.trustedIndex();
    if (index !== null) {
      try {
        return index.slugs().map((s) => ({ id: s.id, kind: s.kind, slug: s.slug }));
      } catch {
        this.indexTrusted = false;
      }
    }
    const entries: SlugEntry[] = [];
    for (const name of await this.listNames()) {
      if (!isItemId(name)) continue;
      let bytes: Uint8Array | null;
      try {
        bytes = await this.deps.store.readItemJson(name);
      } catch (error: unknown) {
        // Przejsciowe (busy, unknown, no-space) przerywaja zapis, bo pominiecie ukryloby kolizje; trwale
        // (symlink, permission-denied, path-too-deep, not-a-file, too-large, invalid-path) pomijamy: element trafia do list().problems i da sie go usunac planem partial.
        if (PERMANENT_FAILURES.has(failureCodeOf(error))) continue;
        throw storeFailed(`odczytać metadane (${name})`, error);
      }
      if (bytes === null) continue;
      try {
        const meta = decodeItemJson(bytes, name);
        entries.push({ id: meta.id, kind: meta.kind, slug: meta.identity.slug });
      } catch (error: unknown) {
        // Przeczytany, ale nieparsowalny item.json nie ma sluga do porownania; list() go zglasza.
        if (!(error instanceof LibraryValidationError)) throw error;
      }
    }
    return entries;
  }

  private async build(
    draft: ItemDraft,
    ctx: { readonly id: ItemId; readonly previous: LoadedItem | null },
  ): Promise<BuiltItem> {
    const { previous } = ctx;
    if (previous !== null && draft.kind !== previous.item.kind) {
      throw validationError(
        'kind-immutable',
        'Typu istniejącego elementu nie można zmienić. Utwórz nowy element.',
        { field: 'kind' },
      );
    }

    const issues: ValidationIssue[] = [];
    const slugProblem = validateSlug(draft.identity.slug);
    if (slugProblem !== null) {
      issues.push(slugProblem);
    } else {
      const collision = findSlugCollision(
        { kind: draft.kind, slug: draft.identity.slug, self: ctx.id },
        await this.existingSlugs(),
      );
      if (collision !== null) issues.push(collision);
    }

    const assetCheck = validateAssetPaths((draft.assets ?? []).map((a) => a.relPath));
    issues.push(...assetCheck.issues);
    for (const snapshot of draft.source?.snapshots ?? []) {
      issues.push(...validateAssetPaths(snapshot.files.map((f) => f.relPath)).issues);
    }
    const body = normalizeToLf(draft.content.body);
    const sizeInput: SizeCheckInput = {
      bodyBytes: new TextEncoder().encode(body).length,
      assets:
        draft.assets === undefined && previous !== null
          ? previous.assets.map((a) => ({ relPath: a.relPath, size: a.bytes.length }))
          : (draft.assets ?? []).map((a) => ({ relPath: a.relPath, size: a.bytes.length })),
      snapshots:
        draft.source === undefined && previous !== null
          ? groupSnapshotSizes(previous.snapshotFiles)
          : (draft.source?.snapshots ?? []).map((snapshot) => ({
              tool: snapshot.tool,
              files: snapshot.files.map((f) => ({ relPath: f.relPath, size: f.bytes.length })),
            })),
    };
    issues.push(...checkSizeLimits(sizeInput));
    const [first, ...rest] = issues;
    if (first !== undefined) throw new LibraryValidationError([first, ...rest]);

    const now = this.deps.clock.now().toISOString();

    let assets: Asset[];
    let assetFiles: AssetFile[];
    if (draft.assets === undefined && previous !== null) {
      assets = [...previous.item.assets];
      assetFiles = [...previous.assets];
    } else {
      assetFiles = (draft.assets ?? []).map((a, i) => ({
        relPath: assetCheck.paths[i] ?? a.relPath,
        bytes: a.bytes,
      }));
      assets = assetFiles.map((f) => ({
        relPath: f.relPath,
        bytesHash: sha256Bytes(f.bytes),
        sizeBytes: f.bytes.length,
      }));
    }

    let snapshots: SourceSnapshot[];
    let snapshotFiles: SnapshotFile[];
    let importedFrom: LibraryItem['source']['importedFrom'];
    if (draft.source === undefined && previous !== null) {
      snapshots = [...previous.item.source.snapshots];
      snapshotFiles = [...previous.snapshotFiles];
      importedFrom = previous.item.source.importedFrom;
    } else {
      snapshotFiles = [];
      snapshots = (draft.source?.snapshots ?? []).map((snapshot) => {
        const paths = validateAssetPaths(snapshot.files.map((f) => f.relPath)).paths;
        return {
          tool: snapshot.tool,
          files: snapshot.files.map((file, i) => {
            const relPath = paths[i] ?? file.relPath;
            snapshotFiles.push({ tool: snapshot.tool, relPath, bytes: file.bytes });
            return {
              relPath,
              bytesHash: sha256Bytes(file.bytes),
              mode: file.mode,
              lineEnding: detectLineEnding(new TextDecoder().decode(file.bytes)),
            };
          }),
          unmappedKeys: snapshot.unmappedKeys,
        };
      });
      importedFrom = draft.source?.importedFrom ?? null;
    }

    const item: LibraryItem = {
      id: ctx.id,
      kind: draft.kind,
      identity: {
        slug: draft.identity.slug,
        declaredName: draft.identity.declaredName,
        aliases: draft.identity.aliases,
      },
      content: {
        title: draft.content.title,
        description: draft.content.description,
        descriptionOrigin: draft.content.descriptionOrigin,
        body,
      },
      attributes: draft.attributes ?? previous?.item.attributes ?? {},
      assets,
      source: { snapshots, importedFrom },
      classification: draft.classification ??
        previous?.item.classification ?? { scope: 'private', secretFindings: [] },
      version: {
        revision: (previous?.item.version.revision ?? 0) + 1,
        contentHash: sha256Text(body),
        updatedAt: now,
      },
    };

    // To, co zaraz zapiszemy, musi przejsc te sama walidacje co odczyt z dysku.
    // Rekord i item.json koduja sie raz; dalej lecą te same bajty (archiwum, zapis, log).
    const record = encodeVersionRecord(item);
    const versionHash = sha256Bytes(record);
    const itemJsonText = encodeItemJson(item, versionHash);
    const itemJson = new TextEncoder().encode(itemJsonText);
    parseItemMeta(JSON.parse(itemJsonText), ctx.id, 'draft');
    this.checkEncodedLimits(sizeInput, itemJson.length, record.length);

    const warning = slugDeclaredNameWarning(item.identity);
    return {
      loaded: { item, assets: assetFiles, snapshotFiles },
      warnings: warning === null ? [] : [warning],
      encoded: {
        itemJson,
        record,
        state: {
          revision: item.version.revision,
          contentHash: item.version.contentHash,
          versionHash,
        },
      },
    };
  }

  /**
   * Limity, ktore znaja dopiero zakodowane bajty: `item.json` i rekord wersji. Wszystko, co tu przejdzie,
   * da sie odczytac przez magazyny (budzet odczytu i `MAX_OBJECT_BYTES`).
   */
  private checkEncodedLimits(
    sizeInput: SizeCheckInput,
    itemJsonBytes: number,
    recordBytes: number,
  ): void {
    const issues = checkSizeLimits({ ...sizeInput, itemJsonBytes });
    if (recordBytes > MAX_OBJECT_BYTES) {
      issues.push({
        reason: 'limit-exceeded',
        message:
          `Zapis wersji elementu zajmuje ${(recordBytes / MIB).toFixed(1)} MiB (znaki sterujące w treści ` +
          `powiększają go przy zapisie), a limit to ${MAX_OBJECT_BYTES / MIB} MiB.`,
        detail: { field: 'content.body' },
      });
    }
    const [first, ...rest] = issues;
    if (first !== undefined) throw new LibraryValidationError([first, ...rest]);
  }

  /** Zapis nowej wersji: najpierw jej rekord i bajty trafiaja do ObjectStore, zeby dalo sie do niej wrocic. */
  private async commit(built: BuiltItem): Promise<void> {
    await this.archive(built.loaded, built.encoded.record, built.encoded.state.versionHash);
    await this.write(built.loaded, built.encoded.itemJson);
  }

  private async write(loaded: LoadedItem, itemJson: Uint8Array): Promise<void> {
    const files: StoredItemFiles = {
      itemJson,
      body: new TextEncoder().encode(loaded.item.content.body),
      assets: loaded.assets,
      snapshotFiles: loaded.snapshotFiles,
    };
    try {
      await this.deps.store.write(loaded.item.id, files);
    } catch (error: unknown) {
      throw storeFailed('zapisać', error);
    }
  }

  private async putVerified(bytes: Uint8Array, knownHash?: Sha256): Promise<Sha256> {
    const expected = knownHash ?? sha256Bytes(bytes);
    if (this.putSeen.has(expected)) return expected;
    if (bytes.length > MAX_OBJECT_BYTES) {
      throw backupFailed(new Error('obiekt przekracza limit rozmiaru magazynu'));
    }
    let actual: Sha256;
    try {
      actual = await this.deps.objects.put(bytes);
    } catch (error: unknown) {
      throw backupFailed(error);
    }
    if (actual !== expected) {
      throw backupFailed(new Error(`ObjectStore zwrócił hash ${actual} zamiast ${expected}`));
    }
    this.putSeen.add(actual);
    return actual;
  }

  /**
   * Zapisuje do ObjectStore rekord wersji i bajty plikow, ktore ten rekord opisuje.
   * Kazda odpowiedz store'u jest porownywana z hashem policzonym lokalnie.
   */
  private async archive(
    loaded: LoadedItem,
    record = encodeVersionRecord(loaded.item),
    recordHash = sha256Bytes(record),
  ): Promise<OperationState> {
    for (const file of loaded.assets) await this.putVerified(file.bytes);
    for (const file of loaded.snapshotFiles) await this.putVerified(file.bytes);
    const versionHash = await this.putVerified(record, recordHash);
    return {
      revision: loaded.item.version.revision,
      contentHash: loaded.item.version.contentHash,
      versionHash,
    };
  }

  /**
   * Kopia przed kazda operacja, ktora nadpisze lub usunie katalog elementu: surowe bajty calego drzewa,
   * a dla elementu spojnego takze rekord wersji, ktory trafia do logu jako stan "przed".
   */
  private async archiveAll(
    salvage: SalvageResult,
    loaded: LoadedItem | null,
    meta: ItemMeta | null,
  ): Promise<OperationState> {
    const raw = await this.archiveSalvage(salvage, meta);
    return loaded === null ? raw : this.archive(loaded);
  }

  /** Awaria logu nie cofa udanego zapisu: element jest na dysku, a ponowienie dalo by kolizje. */
  private async record(input: {
    readonly operation: OperationRecord['operation'];
    readonly itemId: ItemId;
    readonly kind: ItemKind | null;
    readonly slug: string | null;
    readonly before: OperationState | null;
    readonly after: OperationState | null;
  }): Promise<LibraryWarning[]> {
    try {
      await this.deps.log.append({
        operation: input.operation,
        itemId: input.itemId,
        itemKind: input.kind,
        slug: input.slug,
        at: this.deps.clock.now().toISOString(),
        before: input.before,
        after: input.after,
      });
      return [];
    } catch {
      return [
        {
          code: 'operation-log-failed',
          message: 'Operacja została wykonana, ale nie udało się zapisać jej w historii operacji.',
        },
      ];
    }
  }
}

interface BuiltItem {
  readonly loaded: LoadedItem;
  readonly warnings: LibraryWarning[];
  /** Bajty policzone raz w `build`: `item.json`, rekord wersji i stan do logu. */
  readonly encoded: {
    readonly itemJson: Uint8Array;
    readonly record: Uint8Array;
    readonly state: OperationState;
  };
}

function entryOf(item: LibraryItem): LibraryIndexEntry {
  return {
    id: item.id,
    kind: item.kind,
    slug: item.identity.slug,
    slugKey: collisionKey(item.identity.slug),
    title: item.content.title,
    description: item.content.description,
    body: item.content.body,
    revision: item.version.revision,
    contentHash: item.version.contentHash,
    updatedAt: item.version.updatedAt,
  };
}

/** Element niespojny jest w indeksie tylko po nazwie i metadanych z `item.json`; jego tresc na dysku nie jest wiarygodna. */
function inconsistentEntryOf(entry: InconsistentItem): LibraryIndexEntry {
  return {
    id: entry.id,
    kind: entry.kind,
    slug: entry.slug,
    slugKey: collisionKey(entry.slug),
    title: entry.meta.title,
    description: entry.meta.description,
    body: '',
    revision: entry.meta.revision,
    contentHash: entry.meta.contentHash,
    updatedAt: entry.meta.updatedAt,
  };
}

function identityOf(item: LibraryItem): { itemId: ItemId; kind: ItemKind; slug: string } {
  return { itemId: item.id, kind: item.kind, slug: item.identity.slug };
}

function tryInspect(files: StoredItemFiles, id: string): InspectedItem | null {
  try {
    return inspectStoredItem(files, id);
  } catch (error: unknown) {
    if (error instanceof LibraryValidationError) return null;
    throw error;
  }
}

/** Zastepuje poprzednia wersje w `build`, ktory bierze z niej tylko typ i numer rewizji. */
function stubOf(meta: ItemMeta): LoadedItem {
  return { item: metaToItem(meta, ''), assets: [], snapshotFiles: [] };
}

/** Stan z dysku jako draft: wszystkie pliki z `assets/`, snapshoty tylko te, ktore nadal leza na dysku. */
function draftFromDisk(meta: ItemMeta, files: StoredItemFiles, body: string): ItemDraft {
  return {
    kind: meta.kind,
    identity: meta.identity,
    content: { ...meta.content, body },
    attributes: meta.attributes,
    classification: meta.classification,
    assets: files.assets
      .filter((a) => !isIgnoredPath(`assets/${a.relPath}`))
      .map((a) => ({ relPath: a.relPath, bytes: a.bytes })),
    source: {
      importedFrom: meta.source.importedFrom,
      snapshots: meta.source.snapshots.map((snapshot) => ({
        tool: snapshot.tool,
        unmappedKeys: snapshot.unmappedKeys,
        files: snapshot.files.flatMap((entry) => {
          const file = files.snapshotFiles.find(
            (f) => f.tool === snapshot.tool && f.relPath === entry.relPath,
          );
          return file === undefined
            ? []
            : [{ relPath: entry.relPath, bytes: file.bytes, mode: entry.mode }];
        }),
      })),
    },
  };
}

function groupSnapshotSizes(
  files: readonly SnapshotFile[],
): { tool: string; files: { relPath: string; size: number }[] }[] {
  const byTool = new Map<string, { relPath: string; size: number }[]>();
  for (const f of files) {
    const list = byTool.get(f.tool) ?? [];
    list.push({ relPath: f.relPath, size: f.bytes.length });
    byTool.set(f.tool, list);
  }
  return [...byTool].map(([tool, list]) => ({ tool, files: list }));
}

interface DiskTree {
  readonly salvage: SalvageResult;
  readonly files: StoredItemFiles;
}

/** Pliki znane modelowi, wyprowadzone z `readSalvage`; reszta drzewa zostaje tylko w archiwum. */
function filesFromSalvage(salvage: SalvageResult): StoredItemFiles {
  const empty = new Uint8Array();
  const find = (rel: string): Uint8Array =>
    salvage.entries.find((e) => e.relPath === rel)?.bytes ?? empty;
  const assets: AssetFile[] = [];
  const snapshotFiles: SnapshotFile[] = [];
  for (const entry of salvage.entries) {
    if (entry.relPath.startsWith('assets/')) {
      assets.push({ relPath: entry.relPath.slice('assets/'.length), bytes: entry.bytes });
      continue;
    }
    const match = /^snapshots\/([^/]+)\/(.+)$/.exec(entry.relPath);
    const tool = match?.[1];
    if (match !== null && TOOL_IDS.includes(tool as ToolId)) {
      snapshotFiles.push({ tool: tool as ToolId, relPath: match[2]!, bytes: entry.bytes });
    }
  }
  return { itemJson: find('item.json'), body: find('body.md'), assets, snapshotFiles };
}

function partialReason(unrecoverable: readonly UnrecoverableEntry[]): string {
  const list = unrecoverable
    .map((u) => `${u.relPath} (${STORE_FAILURE_TEXT[u.failure]})`)
    .join(', ');
  return `Kopia obejmie tylko pliki, które da się odczytać. Nie da się odczytać: ${list}.`;
}

function metaFromSalvage(salvage: SalvageResult, id: string): ItemMeta | null {
  const entry = salvage.entries.find((e) => e.relPath === 'item.json');
  if (entry === undefined) return null;
  try {
    return decodeItemJson(entry.bytes, id);
  } catch (error: unknown) {
    if (error instanceof LibraryValidationError) return null;
    throw error;
  }
}

function salvageStateHash(salvage: SalvageResult): Sha256 {
  return sha256Bytes(salvageManifest(salvage, { includeJunk: false }));
}
