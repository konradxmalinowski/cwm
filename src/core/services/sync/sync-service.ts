import {
  TOOL_IDS,
  type ItemDraft,
  type ItemId,
  type ItemKind,
  type LibraryItem,
  type ToolId,
} from '../../model/item';
import { LibraryError } from '../../model/library-errors';
import { MAX_FILE_BYTES } from '../../model/library-limits';
import type { ExportDecision, MaterializationMode } from '../../model/plan';
import type { Clock } from '../../ports/clock';
import { cryptoRandomBytes } from '../../ports/id-generator';
import type { OperationLog } from '../../ports/operation-log';
import { SourceReadError, type SourceReader } from '../../ports/source-reader';
import type { SyncRecord, SyncStateStore, SyncedFile } from '../../ports/sync-state';
import type { LocationCatalog, ToolAdapter, ToolExporter } from '../../ports/tool-adapter';
import {
  ExportError,
  type ExportApplyReport,
  type ExportPlanReport,
  type ExportService,
} from '../export/export-service';
import { classifyCandidate, sameContent } from '../import/import-service';
import type { LibraryService } from '../library/library-service';
import { sha256Bytes } from '../normalization/hash';
import { nameOf, parentOf } from './sync-hash';

/**
 * Serwis synchronizacji (ARCHITECTURE 3.5, Etap 5). Stan elementu wzgledem narzedzia wynika z
 * dwoch porownan: biblioteka kontra rekord ostatniej synchronizacji i plik w narzedziu kontra
 * `writtenHash`. Eksport robi `ExportService` (jedna logika zapisu), przyjecie zmian z narzedzia
 * robi `LibraryService.update`. Plan zyje tylko w main pod `syncId`, jest jednorazowy i wygasa.
 */

export type SyncState =
  | 'never'
  | 'in-sync'
  | 'library-changed'
  | 'tool-changed'
  | 'conflict'
  | 'missing-in-tool'
  | 'unsupported';

export type SyncResolution = 'library-wins' | 'tool-wins' | 'skip';

export interface SyncItemStatus {
  readonly itemId: ItemId;
  readonly kind: ItemKind;
  readonly slug: string;
  readonly title: string;
  readonly tool: ToolId;
  readonly status: SyncState;
  readonly lastSyncedAt: string | null;
  readonly materialization: MaterializationMode | null;
}

export interface SyncStatusReport {
  readonly missingTools: readonly ToolId[];
  readonly items: readonly SyncItemStatus[];
  readonly orphans: readonly {
    tool: ToolId;
    rootLabel: string;
    relPath: string;
    reason: string;
  }[];
}

export interface SyncAdoption {
  readonly itemId: ItemId;
  readonly tool: ToolId;
  readonly title: string;
  readonly before: string | null;
  readonly after: string | null;
}

export interface SyncPlanReport {
  readonly syncId: string;
  readonly plans: readonly ExportPlanReport[];
  readonly adoptions: readonly SyncAdoption[];
  readonly skipped: readonly { itemId: string; tool: ToolId; reason: string }[];
  readonly applicable: boolean;
}

export interface SyncApplyReport {
  readonly syncId: string;
  readonly results: readonly ExportApplyReport[];
  readonly adopted: readonly {
    itemId: string;
    tool: ToolId;
    ok: boolean;
    message: string | null;
  }[];
}

export type SyncErrorCode =
  'unknown-sync' | 'sync-expired' | 'not-approved' | 'plan-not-applicable' | 'no-items';

export class SyncError extends Error {
  constructor(
    readonly code: SyncErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

export interface SyncServiceDeps {
  readonly catalog: LocationCatalog;
  readonly adapters: readonly ToolAdapter[];
  readonly exporters: readonly ToolExporter[];
  readonly reader: SourceReader;
  readonly library: Pick<LibraryService, 'list' | 'get' | 'update'>;
  readonly exports: Pick<ExportService, 'plan' | 'preview' | 'apply'>;
  readonly state: SyncStateStore;
  readonly log: OperationLog;
  readonly clock: Clock;
  readonly ttlMs?: number;
  readonly newSyncId?: () => string;
  readonly onUnexpected?: (error: unknown) => void;
}

export const SYNC_TTL_MS = 15 * 60 * 1000;
const MAX_SYNC_PLANS = 8;
const MAX_ITEMS = 500;
const MAX_PREVIEW_CHARS = 256 * 1024;

interface PendingAdoption extends SyncAdoption {
  readonly draft: ItemDraft;
  readonly revision: number;
  readonly files: readonly SyncedFile[];
  readonly kind: ItemKind;
  readonly slug: string;
  /** Biblioteka ma juz te tresc: wystarczy odnowic rekord synchronizacji. */
  readonly noChange: boolean;
}

interface StoredSync {
  readonly expiresAt: number;
  readonly plans: readonly ExportPlanReport[];
  readonly adoptions: readonly PendingAdoption[];
  readonly applicable: boolean;
}

type FileState = 'ok' | 'changed' | 'missing';

function defaultId(): string {
  return Array.from(cryptoRandomBytes(18), (b) => b.toString(16).padStart(2, '0')).join('');
}

function preview(text: string): string | null {
  return text.length > MAX_PREVIEW_CHARS ? null : text;
}

export class SyncService {
  private readonly stored = new Map<string, StoredSync>();
  private readonly exporters: ReadonlyMap<ToolId, ToolExporter>;
  private readonly adapters: ReadonlyMap<ToolId, ToolAdapter>;
  private readonly ttlMs: number;
  private readonly newId: () => string;

  constructor(private readonly deps: SyncServiceDeps) {
    this.exporters = new Map(deps.exporters.map((e) => [e.id, e]));
    this.adapters = new Map(deps.adapters.map((a) => [a.id, a]));
    this.ttlMs = deps.ttlMs ?? SYNC_TTL_MS;
    this.newId = deps.newSyncId ?? defaultId;
  }

  // --- status ---

  async status(tools?: readonly ToolId[]): Promise<SyncStatusReport> {
    const wanted = tools === undefined || tools.length === 0 ? TOOL_IDS : [...new Set(tools)];
    const library = (await this.deps.library.list()).items;
    const missingTools: ToolId[] = [];
    const items: SyncItemStatus[] = [];
    const orphans: SyncStatusReport['orphans'][number][] = [];

    for (const tool of wanted) {
      if (!(await this.deps.catalog.toolHomeExists(tool))) {
        missingTools.push(tool);
        continue;
      }
      const records = new Map((await this.deps.state.list(tool)).map((r) => [r.itemId, r]));
      const supported: ItemId[] = [];
      for (const item of library) {
        const record = records.get(item.id) ?? null;
        const status = await this.stateOf(item, tool, record);
        if (status !== 'unsupported') supported.push(item.id);
        items.push({
          itemId: item.id,
          kind: item.kind,
          slug: item.identity.slug,
          title: item.content.title,
          tool,
          status,
          lastSyncedAt: record?.syncedAt ?? null,
          materialization:
            record === null
              ? null
              : (record.files.find((f) => f.materialization !== undefined)?.materialization ??
                'copy'),
        });
      }
      orphans.push(...(await this.orphansOf(tool, supported)));
    }
    return { missingTools, items, orphans };
  }

  private async orphansOf(
    tool: ToolId,
    itemIds: readonly ItemId[],
  ): Promise<SyncStatusReport['orphans'][number][]> {
    if (itemIds.length === 0 || itemIds.length > MAX_ITEMS) return [];
    try {
      const report = await this.deps.exports.preview(tool, itemIds);
      return report.plan.orphans.map((o) => ({
        tool,
        rootLabel: report.rootLabels.get(o.rootId) ?? 'nieznana lokalizacja',
        relPath: o.relPath,
        reason: o.reason,
      }));
    } catch (error: unknown) {
      if (!(error instanceof ExportError)) this.deps.onUnexpected?.(error);
      return [];
    }
  }

  private async stateOf(
    item: LibraryItem,
    tool: ToolId,
    record: SyncRecord | null,
  ): Promise<SyncState> {
    if (record === null) {
      const exporter = this.exporters.get(tool);
      return exporter === undefined || exporter.capabilities(item).level === 'unsupported'
        ? 'unsupported'
        : 'never';
    }
    const fileState = await this.inspect(record);
    if (fileState === 'missing') return 'missing-in-tool';
    const library =
      item.version.contentHash !== record.itemContentHash ||
      item.version.revision !== record.itemRevision;
    const tooled = fileState === 'changed';
    if (library && tooled) return 'conflict';
    if (library) return 'library-changed';
    return tooled ? 'tool-changed' : 'in-sync';
  }

  /** Najgorszy stan sposrod plikow rekordu: brak pliku wazy wiecej niz zmiana. */
  private async inspect(record: SyncRecord): Promise<FileState> {
    let worst: FileState = 'ok';
    for (const file of record.files) {
      const state = await this.inspectFile(file);
      if (state === 'missing') return 'missing';
      if (state === 'changed') worst = 'changed';
    }
    return worst;
  }

  private async inspectFile(file: SyncedFile): Promise<FileState> {
    try {
      if (file.materialization === 'symlink' || file.materialization === 'junction') {
        return await this.inspectLink(file);
      }
      const bytes = await this.deps.reader.read(file.rootId, file.relPath, MAX_FILE_BYTES);
      // Plik wspolny (blok miedzy markerami, segment TOML, klucz JSON) ma tez cudza tresc.
      if (file.scope !== undefined && file.scope !== 'whole-file') return 'ok';
      return sha256Bytes(bytes) === file.writtenHash ? 'ok' : 'changed';
    } catch (error: unknown) {
      if (error instanceof SourceReadError && error.failure === 'not-found') return 'missing';
      return 'changed';
    }
  }

  /** Dowiazania reader nie przechodzi, wiec tresc materializacji jest poza zasiegiem; sprawdzamy sam wpis. */
  private async inspectLink(file: SyncedFile): Promise<FileState> {
    if (file.relPath === '') {
      const bytes = await this.deps.reader.read(file.rootId, '', MAX_FILE_BYTES);
      return sha256Bytes(bytes) === file.writtenHash ? 'ok' : 'changed';
    }
    const entries = await this.deps.reader.list(file.rootId, parentOf(file.relPath));
    const entry = entries.find((e) => e.name === nameOf(file.relPath));
    if (entry === undefined) return 'missing';
    if (entry.type === 'symlink') return 'ok';
    if (entry.type === 'file') {
      const bytes = await this.deps.reader.read(file.rootId, file.relPath, MAX_FILE_BYTES);
      return sha256Bytes(bytes) === file.writtenHash ? 'ok' : 'changed';
    }
    return 'changed';
  }

  // --- plan ---

  async plan(
    tools: readonly ToolId[],
    itemIds: readonly string[],
    resolutions: readonly { itemId: string; tool: ToolId; resolution: SyncResolution }[] = [],
    exportDecisions: readonly ExportDecision[] = [],
  ): Promise<SyncPlanReport> {
    const ids = [...new Set(itemIds)];
    const wantedTools = [...new Set(tools)];
    if (ids.length === 0 || ids.length > MAX_ITEMS || wantedTools.length === 0) {
      throw new SyncError('no-items', 'Wybierz narzędzia i od jednego do kilkuset elementów.');
    }
    const library = new Map((await this.deps.library.list()).items.map((i) => [i.id as string, i]));
    const decided = new Map(resolutions.map((r) => [`${r.tool}\0${r.itemId}`, r.resolution]));

    const plans: ExportPlanReport[] = [];
    const adoptions: PendingAdoption[] = [];
    const skipped: { itemId: string; tool: ToolId; reason: string }[] = [];

    for (const tool of wantedTools) {
      if (!(await this.deps.catalog.toolHomeExists(tool))) {
        for (const id of ids) {
          skipped.push({
            itemId: id,
            tool,
            reason: 'Narzędzie nie ma katalogu głównego na tym komputerze.',
          });
        }
        continue;
      }
      const records = new Map(
        (await this.deps.state.list(tool)).map((r) => [r.itemId as string, r]),
      );
      const toExport: string[] = [];

      for (const id of ids) {
        const item = library.get(id);
        if (item === undefined) {
          skipped.push({ itemId: id, tool, reason: 'Nie znaleziono elementu w bibliotece.' });
          continue;
        }
        const record = records.get(id) ?? null;
        const status = await this.stateOf(item, tool, record);
        const choice = decided.get(`${tool}\0${id}`);
        switch (status) {
          case 'in-sync':
            break;
          case 'unsupported':
            skipped.push({
              itemId: id,
              tool,
              reason: 'To narzędzie nie obsługuje tego rodzaju elementu.',
            });
            break;
          case 'never':
          case 'library-changed':
          case 'missing-in-tool':
            if (choice === 'skip')
              skipped.push({ itemId: id, tool, reason: 'Pominięto na życzenie.' });
            else toExport.push(id);
            break;
          case 'conflict':
          case 'tool-changed': {
            if (choice === 'library-wins') {
              toExport.push(id);
            } else if (choice === 'tool-wins' && record !== null) {
              const outcome = await this.prepareAdoption(item, tool, record);
              if (typeof outcome === 'string') skipped.push({ itemId: id, tool, reason: outcome });
              else adoptions.push(outcome);
            } else {
              skipped.push({
                itemId: id,
                tool,
                reason:
                  choice === 'skip'
                    ? 'Pominięto na życzenie.'
                    : status === 'conflict'
                      ? 'Zmiana po obu stronach. Wybierz, która wersja ma wygrać.'
                      : 'Plik zmienił się w narzędziu. Wybierz, czy przyjąć zmianę, czy ją nadpisać.',
              });
            }
            break;
          }
        }
      }

      if (toExport.length > 0) {
        try {
          plans.push(await this.deps.exports.plan(tool, toExport, exportDecisions));
        } catch (error: unknown) {
          if (!(error instanceof ExportError)) throw error;
          for (const id of toExport) skipped.push({ itemId: id, tool, reason: error.message });
        }
      }
    }

    const syncId = this.newId();
    const planned = plans.some((p) => p.plan.entries.some((e) => e.action !== 'unchanged'));
    const applicable =
      (planned || adoptions.length > 0) && plans.every((p) => p.plan.applicable && !p.toolMissing);
    this.remember(syncId, { plans, adoptions, applicable });
    return {
      syncId,
      plans,
      adoptions: adoptions.map(({ itemId, tool, title, before, after }) => ({
        itemId,
        tool,
        title,
        before,
        after,
      })),
      skipped,
      applicable,
    };
  }

  /** Zmiana z narzedzia: odczyt przez adapter importu, dopasowanie po sciezce wzglednej z rekordu. */
  private async prepareAdoption(
    item: LibraryItem,
    tool: ToolId,
    record: SyncRecord,
  ): Promise<PendingAdoption | string> {
    const adapter = this.adapters.get(tool);
    if (adapter === undefined) return 'Brak adaptera tego narzędzia.';
    const roots = (await this.deps.catalog.detect()).filter((r) => r.tool === tool && r.exists);
    const rootIds = [...new Set(record.files.map((f) => f.rootId))];

    for (const rootId of rootIds) {
      const root = roots.find((r) => r.rootId === rootId);
      if (root === undefined) continue;
      const paths = record.files.filter((f) => f.rootId === rootId).map((f) => f.relPath);
      let scan;
      try {
        scan = await adapter.scan(root, this.deps.reader);
      } catch (error: unknown) {
        this.deps.onUnexpected?.(error);
        return 'Nie udało się odczytać zmiany z narzędzia.';
      }
      const related = scan.candidates.filter(
        (c) =>
          c.rootId === rootId &&
          c.kind === item.kind &&
          paths.some(
            (p) =>
              p === c.relPath || p.startsWith(`${c.relPath}/`) || c.relPath.startsWith(`${p}/`),
          ),
      );
      const match =
        related.find((c) => c.draft.identity.slug === item.identity.slug) ??
        (related.length === 1 ? related[0] : undefined);
      if (match === undefined) continue;

      if (classifyCandidate(match).length > 0) {
        return 'Zmiana zawiera dane przypominające sekret. Zaimportuj ją ręcznie przez Import.';
      }
      const files: SyncedFile[] = [];
      for (const file of record.files) {
        if (file.materialization !== undefined) {
          files.push(file);
          continue;
        }
        try {
          const bytes = await this.deps.reader.read(file.rootId, file.relPath, MAX_FILE_BYTES);
          files.push({ ...file, writtenHash: sha256Bytes(bytes) });
        } catch {
          return 'Nie udało się odczytać pliku z narzędzia.';
        }
      }
      const draft: ItemDraft = {
        ...match.draft,
        identity: { ...match.draft.identity, slug: item.identity.slug },
        classification: { scope: item.classification.scope, secretFindings: [] },
        source: {
          snapshots: match.draft.source?.snapshots ?? [],
          importedFrom: {
            tool,
            rootId,
            path: match.relPath,
            at: this.deps.clock.now().toISOString(),
          },
        },
      };
      return {
        itemId: item.id,
        tool,
        title: item.content.title,
        before: preview(item.content.body),
        after: preview(match.draft.content.body),
        draft,
        revision: item.version.revision,
        files,
        kind: item.kind,
        slug: item.identity.slug,
        noChange: sameContent(draft, item),
      };
    }
    return 'Nie znaleziono w narzędziu elementu pasującego do zapisanego pliku.';
  }

  // --- apply ---

  async apply(syncId: string, approved: boolean): Promise<SyncApplyReport> {
    if (!approved)
      throw new SyncError('not-approved', 'Synchronizacja wymaga jawnego zatwierdzenia planu.');
    const session = this.stored.get(syncId);
    if (session === undefined) {
      throw new SyncError(
        'unknown-sync',
        'Nieznany plan synchronizacji. Przygotuj plan jeszcze raz.',
      );
    }
    this.stored.delete(syncId);
    if (this.deps.clock.now().getTime() > session.expiresAt) {
      throw new SyncError('sync-expired', 'Plan synchronizacji wygasł. Przygotuj go jeszcze raz.');
    }
    if (!session.applicable) {
      throw new SyncError(
        'plan-not-applicable',
        'Tego planu nie da się zastosować. Usuń blokady i przygotuj plan jeszcze raz.',
      );
    }

    const at = (): string => this.deps.clock.now().toISOString();
    const results: ExportApplyReport[] = [];
    for (const report of session.plans) {
      let result: ExportApplyReport;
      try {
        result = await this.deps.exports.apply(report.planId, true);
      } catch (error: unknown) {
        if (!(error instanceof ExportError)) this.deps.onUnexpected?.(error);
        const message =
          error instanceof ExportError
            ? error.message
            : 'Zapis nie powiódł się. Szczegóły są w logu aplikacji.';
        result = {
          planId: report.planId,
          backupId: '',
          entries: report.plan.entries.map((_e, i) => ({
            entryId: report.entryIds[i] ?? `e${i + 1}`,
            outcome: 'failed' as const,
            message,
          })),
          verified: false,
          rolledBack: false,
        };
      }
      results.push(result);
      if (result.verified && !result.rolledBack) {
        const byId = new Map(report.items.map((i) => [i.itemId, i]));
        const touched = new Set(report.plan.entries.flatMap((e) => e.itemIds));
        for (const itemId of touched) {
          const item = byId.get(itemId);
          await this.logSync(
            itemId,
            item?.kind ?? null,
            item?.slug ?? null,
            report.tool,
            result.backupId,
            at(),
          );
        }
      }
    }

    const adopted: SyncApplyReport['adopted'][number][] = [];
    for (const adoption of session.adoptions) {
      adopted.push(await this.applyAdoption(adoption, at));
    }
    return { syncId, results, adopted };
  }

  private async applyAdoption(
    adoption: PendingAdoption,
    now: () => string,
  ): Promise<SyncApplyReport['adopted'][number]> {
    const base = { itemId: adoption.itemId, tool: adoption.tool };
    try {
      const current = await this.deps.library.get(adoption.itemId);
      if (current.item.version.revision !== adoption.revision) {
        return { ...base, ok: false, message: 'Element zmienił się od przygotowania planu.' };
      }
      const item = adoption.noChange
        ? current.item
        : (await this.deps.library.update(adoption.itemId, adoption.draft)).item;
      await this.deps.state.put({
        itemId: item.id,
        tool: adoption.tool,
        itemRevision: item.version.revision,
        itemContentHash: item.version.contentHash,
        files: adoption.files,
        syncedAt: now(),
        backupId: '',
      });
      await this.logSync(item.id, adoption.kind, adoption.slug, adoption.tool, '', now());
      return { ...base, ok: true, message: null };
    } catch (error: unknown) {
      if (error instanceof LibraryError) return { ...base, ok: false, message: error.message };
      this.deps.onUnexpected?.(error);
      return {
        ...base,
        ok: false,
        message: 'Nie udało się przyjąć zmiany. Szczegóły są w logu aplikacji.',
      };
    }
  }

  /** Wpis logu jest pomocniczy: jego brak nie cofa synchronizacji, ktora sie odbyla. */
  private async logSync(
    itemId: ItemId,
    kind: ItemKind | null,
    slug: string | null,
    tool: ToolId,
    backupId: string,
    at: string,
  ): Promise<void> {
    await this.deps.log
      .append({
        operation: 'sync',
        itemId,
        itemKind: kind,
        slug,
        at,
        before: null,
        after: null,
        tool,
        ...(backupId === '' ? {} : { backupId }),
      })
      .catch(() => undefined);
  }

  private remember(syncId: string, value: Omit<StoredSync, 'expiresAt'>): void {
    const nowMs = this.deps.clock.now().getTime();
    for (const [id, s] of this.stored) if (s.expiresAt < nowMs) this.stored.delete(id);
    while (this.stored.size >= MAX_SYNC_PLANS) {
      const oldest = this.stored.keys().next().value;
      if (oldest === undefined) break;
      this.stored.delete(oldest);
    }
    this.stored.set(syncId, { ...value, expiresAt: nowMs + this.ttlMs });
  }
}
