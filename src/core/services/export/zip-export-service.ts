import type { ItemId, ItemKind, ItemScope, LoadedItem, ToolId } from '../../model/item';
import type { WritePlan, WritePlanEntry } from '../../model/plan';
import type { Clock } from '../../ports/clock';
import { cryptoRandomBytes } from '../../ports/id-generator';
import { SourceReadError, type SourceReader } from '../../ports/source-reader';
import type {
  DetectedRoot,
  ExportContext,
  LocationCatalog,
  RootKind,
  ToolExporter,
} from '../../ports/tool-adapter';
import type { LibraryService } from '../library/library-service';
import { classifyStrict, type SecretScanFile } from '../security/secret-classifier';
import {
  ExportError,
  MAX_PLAN_ITEMS,
  type ExportPlanReport,
  type PlannedItem,
} from './export-service';
import {
  ZIP_MAX_TOTAL_BYTES,
  ZipError,
  buildZip,
  type BuiltZip,
  type ZipFileInput,
} from './zip-archive';

/**
 * Eksport do archiwum ZIP (ADR 0054). Plan powstaje tym samym eksporterem co zapis do narzedzia,
 * tylko na pustym celu: czytnik nie widzi niczego, wiec kazdy plik jest nowy, a nic nie jest
 * scalane z tym, co lezy w konfiguracji uzytkownika. Archiwum jest budowane od razu i trzymane w
 * main pod `planId`, wiec do pliku trafia dokladnie to, co uzytkownik zobaczyl w planie.
 */

export const ZIP_PLAN_TTL_MS = 15 * 60 * 1000;
/** Wygasle plany sa sprzatane co tyle, takze gdy nikt nie pyta o nowy. */
const SWEEP_INTERVAL_MS = 60 * 1000;
const NO_TARGET = 'Archiwum nie ma istniejącego celu.';

/**
 * Czemu element nie trafia do archiwum bez zgody (`private`, `secret`, `path`) albo wcale (`project`).
 * `path`: element niesie lokalna sciezke bezwzgledna (np. komende hooka), czyli katalog domowy autora.
 */
export type ZipHoldReason = 'private' | 'secret' | 'path' | 'project';

export interface ZipHeldItem {
  readonly itemId: ItemId;
  readonly kind: ItemKind;
  readonly slug: string;
  readonly title: string;
  readonly reason: ZipHoldReason;
  /** Zgoda uzytkownika; `project` nie ma zgody, zawsze zostaje poza archiwum. */
  readonly confirmed: boolean;
}

export interface ZipPlanReport {
  readonly report: ExportPlanReport;
  readonly held: readonly ZipHeldItem[];
  readonly archive: {
    readonly fileName: string;
    /** Pliki razem z manifestem. */
    readonly fileCount: number;
    readonly sizeBytes: number;
  };
}

/** Stan elementu w chwili planu: zapis sprawdza, czy sie nie zmienil, zanim cos trafi na dysk. */
export interface ZipItemStamp {
  readonly itemId: ItemId;
  readonly revision: number;
  readonly scope: ItemScope;
  readonly findings: number;
}

export interface ZipPayload {
  readonly planId: string;
  readonly items: readonly ZipItemStamp[];
  readonly tool: ToolId;
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly fileCount: number;
  readonly itemCount: number;
}

interface StoredZip {
  readonly expiresAt: number;
  readonly payload: ZipPayload;
}

export interface ZipExportDeps {
  readonly catalog: Pick<LocationCatalog, 'detect'>;
  readonly exporters: readonly ToolExporter[];
  readonly library: Pick<LibraryService, 'get' | 'list'>;
  readonly clock: Clock;
  readonly appVersion: string;
  readonly deflate: (bytes: Uint8Array) => Uint8Array;
  readonly ttlMs?: number;
  readonly newPlanId?: () => string;
}

function defaultPlanId(): string {
  return Array.from(cryptoRandomBytes(18), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Czytnik pustego celu: kazdy plik jest nowy, nic z konfiguracji uzytkownika nie jest czytane. */
const EMPTY_TARGET: SourceReader = {
  list: () => Promise.reject(new SourceReadError('not-found', '', NO_TARGET)),
  read: () => Promise.reject(new SourceReadError('not-found', '', NO_TARGET)),
  resolveSymlink: () => Promise.reject(new SourceReadError('not-found', '', NO_TARGET)),
  mode: () => Promise.resolve(null),
};

/** Jak etykieta roota (`~/.claude/skills`) wchodzi do sciezki w archiwum; zmienne srodowiska maja stala nazwe. */
const LABEL_PREFIXES: readonly (readonly [string, string])[] = [
  ['~/', ''],
  ['$CLAUDE_CONFIG_DIR/', '.claude/'],
  ['$CODEX_HOME/', '.codex/'],
];

function rootDirectory(label: string): string | null {
  for (const [prefix, replacement] of LABEL_PREFIXES) {
    if (label.startsWith(prefix)) return `${replacement}${label.slice(prefix.length)}`;
  }
  return null;
}

/** Rooty, ktorych etykieta jest plikiem (CLAUDE.md, settings.json, config.toml). */
const FILE_ROOTS: ReadonlySet<RootKind> = new Set<RootKind>([
  'global-instructions',
  'hooks',
  'agent-registry',
]);

/**
 * Dla rootu bedacego plikiem etykieta konczy sie nazwa pliku, a `relPath` zaczyna sie od niej:
 * samo sklejenie dalo by "CLAUDE.md/CLAUDE.md".
 */
function joinLabel(directory: string, relPath: string, fileRoot: boolean): string {
  if (!fileRoot) return `${directory}/${relPath}`;
  const first = relPath.split('/')[0] ?? '';
  return `${directory}${relPath.slice(first.length)}`;
}

/** Pola, ktore trafiaja do plikow narzedzia, ale nie sa trescia: tytul, opis, nazwy, hook, ustawienie. */
function metadataText(loaded: LoadedItem): string {
  const { content, identity, attributes } = loaded.item;
  const lines = [
    `title: ${content.title}`,
    `description: ${content.description}`,
    ...(identity.declaredName === null ? [] : [`name: ${identity.declaredName}`]),
    ...identity.aliases.map((a) => `alias: ${a}`),
  ];
  const { hook, toolSetting } = attributes;
  if (hook !== undefined) {
    lines.push(
      `event: ${hook.event}`,
      `matcher: ${hook.matcher ?? ''}`,
      `command: ${hook.command}`,
    );
  }
  if (toolSetting !== undefined) {
    lines.push(`${toolSetting.key}: ${JSON.stringify(toolSetting.value)}`);
  }
  return lines.join('\n');
}

/** Strict, bo przy plikach, ktore wyjda z komputera, nadmiar trafien jest tanszy od przeoczenia. */
function scanFiles(loaded: LoadedItem, tool: ToolId): SecretScanFile[] {
  const encoder = new TextEncoder();
  return [
    { relPath: `${loaded.item.identity.slug}.md`, bytes: encoder.encode(loaded.item.content.body) },
    { relPath: 'metadata.txt', bytes: encoder.encode(metadataText(loaded)) },
    ...loaded.assets.map((a) => ({ relPath: a.relPath, bytes: a.bytes })),
    ...loaded.snapshotFiles
      .filter((f) => f.tool === tool)
      .map((f) => ({ relPath: f.relPath, bytes: f.bytes })),
  ];
}

const LOCAL_PATH = /(?:^|[\s"'=:(])(?:\/(?:Users|home)\/[^\s"']+|[A-Za-z]:\\[^\s"']+)/;

function hasLocalPath(loaded: LoadedItem): boolean {
  const { hook, toolSetting } = loaded.item.attributes;
  if (hook !== undefined && (hook.pathStyle === 'absolute' || LOCAL_PATH.test(hook.command))) {
    return true;
  }
  return toolSetting !== undefined && LOCAL_PATH.test(JSON.stringify(toolSetting.value));
}

function holdReason(loaded: LoadedItem, tool: ToolId): ZipHoldReason | null {
  const { classification } = loaded.item;
  if (classification.scope === 'project') return 'project';
  if (
    classification.secretFindings.length > 0 ||
    classifyStrict(scanFiles(loaded, tool)).length > 0
  ) {
    return 'secret';
  }
  if (hasLocalPath(loaded)) return 'path';
  return classification.scope === 'private' ? 'private' : null;
}

function bodyAndAssetBytes(loaded: LoadedItem): number {
  return (
    new TextEncoder().encode(loaded.item.content.body).byteLength +
    loaded.assets.reduce((sum, a) => sum + a.bytes.byteLength, 0)
  );
}

/** Pliki wpisu planu: to, co trafi do archiwum. */
function entryBytes(entry: WritePlanEntry): { relPath: string; bytes: Uint8Array }[] {
  if (entry.files !== null) {
    return entry.files.map((f) => ({ relPath: `${entry.relPath}/${f.relPath}`, bytes: f.bytes }));
  }
  return entry.content === null ? [] : [{ relPath: entry.relPath, bytes: entry.content }];
}

function tooLarge(): ExportError {
  return new ExportError('zip-too-large', 'Zawartość archiwum przekracza limit 64 MiB.');
}

function utcStamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
}

function entryFiles(
  entry: WritePlanEntry,
  directory: string,
  fileRoot: boolean,
): { path: string; bytes: Uint8Array }[] {
  if (entry.files !== null) {
    return entry.files.map((f) => ({
      path: joinLabel(directory, `${entry.relPath}/${f.relPath}`, fileRoot),
      bytes: f.bytes,
    }));
  }
  if (entry.content === null) return [];
  return [{ path: joinLabel(directory, entry.relPath, fileRoot), bytes: entry.content }];
}

export class ZipExportService {
  private readonly stored = new Map<string, StoredZip>();
  private planning = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly exporters: ReadonlyMap<ToolId, ToolExporter>;
  private readonly ttlMs: number;
  private readonly newPlanId: () => string;

  constructor(private readonly deps: ZipExportDeps) {
    this.exporters = new Map(deps.exporters.map((e) => [e.id, e]));
    this.ttlMs = deps.ttlMs ?? ZIP_PLAN_TTL_MS;
    this.newPlanId = deps.newPlanId ?? defaultPlanId;
  }

  /**
   * `tool` wybiera uklad plikow w archiwum. `confirmedItemIds` to zgoda uzytkownika dla elementow
   * prywatnych i z trafieniem klasyfikatora sekretow; element zalezny od projektu jej nie dostaje.
   */
  async plan(
    tool: ToolId,
    itemIds: readonly string[],
    confirmedItemIds: readonly string[] = [],
  ): Promise<ZipPlanReport> {
    const exporter = this.exporters.get(tool);
    if (exporter === undefined) {
      throw new ExportError(
        'unsupported-tool',
        'Eksport do tego układu nie jest jeszcze dostępny.',
      );
    }
    const wanted = [...new Set(itemIds)];
    if (wanted.length === 0 || wanted.length > MAX_PLAN_ITEMS) {
      throw new ExportError('no-items', 'Wybierz od jednego do kilkuset elementów do eksportu.');
    }
    const confirmed = new Set(confirmedItemIds);
    if (this.planning) {
      throw new ExportError('zip-busy', 'Przygotowanie archiwum już trwa. Poczekaj chwilę.');
    }
    this.planning = true;
    try {
      return await this.build(tool, exporter, wanted, confirmed);
    } finally {
      this.planning = false;
    }
  }

  private async build(
    tool: ToolId,
    exporter: ToolExporter,
    wanted: readonly string[],
    confirmed: ReadonlySet<string>,
  ): Promise<ZipPlanReport> {
    // Nowy plan uniewaznia kazdy poprzedni: w main zyje jedno archiwum naraz.
    this.stored.clear();
    await this.checkMetadataSize(wanted);

    const loaded: LoadedItem[] = [];
    let total = 0;
    for (const id of wanted) {
      const item = await this.deps.library.get(id);
      total += bodyAndAssetBytes(item);
      if (total > ZIP_MAX_TOTAL_BYTES) throw tooLarge();
      loaded.push(item);
    }

    const reasons = new Map<string, ZipHoldReason>();
    for (const l of loaded) {
      const reason = holdReason(l, tool);
      if (reason !== null) reasons.set(l.item.id, reason);
    }

    const planId = this.newPlanId();
    const now = this.deps.clock.now();
    const roots = this.layoutRoots(await this.deps.catalog.detect(), tool);
    const rootLabels = new Map(roots.map((r) => [r.rootId, r.label]));
    const rootKinds = new Map(roots.map((r) => [r.rootId, r.kind]));
    const ctx: ExportContext = {
      roots,
      reader: EMPTY_TARGET,
      materialization: { directory: 'copy', file: 'copy' },
    };

    let included: LoadedItem[];
    let drafted: WritePlan;
    let entries: WritePlanEntry[];
    const probedAt = now.toISOString();
    for (;;) {
      included = loaded.filter((l) => {
        const reason = reasons.get(l.item.id);
        return reason === undefined || (reason !== 'project' && confirmed.has(l.item.id));
      });
      drafted =
        included.length === 0
          ? {
              planId,
              tool,
              createdAt: probedAt,
              entries: [],
              verdicts: [],
              refusals: [],
              conflicts: [],
              orphans: [],
              applicable: false,
            }
          : await exporter.plan(included, ctx);
      entries = drafted.entries.map((e) => ({
        ...e,
        recoverability: { status: 'recoverable', reason: null, probedAt },
      }));
      // Siatka bezpieczenstwa: to, co eksporter wygenerowal, tez przechodzi klasyfikator.
      const flagged = new Set<string>();
      for (const entry of entries) {
        const hits = classifyStrict(entryBytes(entry).map((f) => ({ ...f })));
        if (hits.length > 0) for (const id of entry.itemIds) flagged.add(id);
      }
      const fresh = [...flagged].filter((id) => reasons.get(id) !== 'secret');
      if (fresh.length === 0) break;
      for (const id of fresh) reasons.set(id, 'secret');
    }

    const held: ZipHeldItem[] = [];
    for (const l of loaded) {
      const reason = reasons.get(l.item.id);
      if (reason === undefined) continue;
      held.push({
        itemId: l.item.id,
        kind: l.item.kind,
        slug: l.item.identity.slug,
        title: l.item.content.title,
        reason,
        confirmed: reason !== 'project' && confirmed.has(l.item.id),
      });
    }
    const items: PlannedItem[] = included.map(({ item }) => ({
      itemId: item.id,
      kind: item.kind,
      slug: item.identity.slug,
      title: item.content.title,
      revision: item.version.revision,
      contentHash: item.version.contentHash,
    }));

    const inputs: ZipFileInput[] = [];
    for (const entry of entries) {
      const label = rootLabels.get(entry.rootId);
      const directory = label === undefined ? null : rootDirectory(label);
      if (directory === null) {
        throw new ExportError('zip-invalid-path', 'Nie rozpoznano lokalizacji pliku dla archiwum.');
      }
      const fileRoot = FILE_ROOTS.has(rootKinds.get(entry.rootId) ?? 'skills');
      for (const file of entryFiles(entry, directory, fileRoot)) {
        inputs.push({ path: `${tool}/${file.path}`, bytes: file.bytes });
      }
    }

    let built: BuiltZip;
    try {
      built = buildZip(inputs, {
        appVersion: this.deps.appVersion,
        layout: tool,
        deflate: this.deps.deflate,
      });
    } catch (error: unknown) {
      if (error instanceof ZipError) throw new ExportError(`zip-${error.code}`, error.message);
      throw error;
    }

    const fileName = `cwm-export-${tool}-${utcStamp(now)}.zip`;
    const applicable = drafted.applicable && inputs.length > 0;
    const plan: WritePlan = { ...drafted, planId, entries, applicable };
    const report: ExportPlanReport = {
      planId,
      tool,
      toolMissing: false,
      plan,
      items,
      rootLabels,
      entryIds: entries.map((_e, i) => `e${i + 1}`),
    };
    if (applicable) {
      this.remember({
        planId,
        items: included.map(({ item }) => ({
          itemId: item.id,
          revision: item.version.revision,
          scope: item.classification.scope,
          findings: item.classification.secretFindings.length,
        })),
        tool,
        fileName,
        bytes: built.bytes,
        fileCount: built.fileCount,
        itemCount: included.length,
      });
    }
    return {
      report,
      held,
      archive: { fileName, fileCount: built.fileCount, sizeBytes: built.bytes.byteLength },
    };
  }

  /** Archiwum do zapisu. Plan zostaje, dopoki `consume` go nie zuzyje: anulowane okno zapisu nic nie traci. */
  peek(planId: string): ZipPayload {
    const stored = this.stored.get(planId);
    if (stored === undefined) {
      throw new ExportError('unknown-plan', 'Nieznany plan. Przygotuj plan archiwum jeszcze raz.');
    }
    if (this.deps.clock.now().getTime() > stored.expiresAt) {
      this.stored.delete(planId);
      throw new ExportError('plan-expired', 'Plan wygasł. Przygotuj plan archiwum jeszcze raz.');
    }
    return stored.payload;
  }

  consume(planId: string): void {
    this.stored.delete(planId);
  }

  /** Czy elementy z planu sa takie same jak przy planowaniu: zakres, rewizja i trafienia sekretow. */
  async verify(planId: string): Promise<void> {
    const { items } = this.peek(planId);
    for (const stamp of items) {
      const current = await this.deps.library.get(stamp.itemId).catch(() => null);
      const same =
        current !== null &&
        current.item.version.revision === stamp.revision &&
        current.item.classification.scope === stamp.scope &&
        current.item.classification.secretFindings.length === stamp.findings;
      if (!same) {
        throw new ExportError(
          'zip-stale',
          'Element zmienił się po przygotowaniu planu. Przygotuj plan archiwum jeszcze raz.',
        );
      }
    }
  }

  /** Usuwa wygasle plany; wywolywane tez z timera, wiec stary plan nie wisi w pamieci bez ruchu. */
  sweep(): void {
    const nowMs = this.deps.clock.now().getTime();
    for (const [id, value] of this.stored) if (value.expiresAt < nowMs) this.stored.delete(id);
    if (this.stored.size === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Odrzuca zbyt duzy wybor po metadanych, zanim jakikolwiek plik zostanie wczytany. */
  private async checkMetadataSize(wanted: readonly string[]): Promise<void> {
    const listing = await this.deps.library.list().catch(() => null);
    if (listing === null) return;
    const ids = new Set(wanted);
    let total = 0;
    for (const item of listing.items) {
      if (!ids.has(item.id)) continue;
      total += item.content.body.length;
      for (const asset of item.assets) total += asset.sizeBytes;
      if (total > ZIP_MAX_TOTAL_BYTES) throw tooLarge();
    }
  }

  /** Rooty tego narzedzia: wszystkie istnieja, a z kilku tego samego rodzaju aktywny jest pierwszy. */
  private layoutRoots(all: readonly DetectedRoot[], tool: ToolId): DetectedRoot[] {
    const firstOfKind = new Set<string>();
    const roots: DetectedRoot[] = [];
    for (const root of all) {
      if (root.tool !== tool) continue;
      const first = !firstOfKind.has(root.kind);
      firstOfKind.add(root.kind);
      roots.push({ ...root, exists: true, active: first });
    }
    return roots;
  }

  private remember(payload: ZipPayload): void {
    const nowMs = this.deps.clock.now().getTime();
    this.stored.clear();
    this.stored.set(payload.planId, { expiresAt: nowMs + this.ttlMs, payload });
    if (this.timer === null) {
      this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
      this.timer.unref();
    }
  }
}
