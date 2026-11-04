import type { ItemId, LoadedItem, Sha256, ToolId } from '../../model/item';
import type { ApplyReport, WritePlan } from '../../model/plan';
import type { Clock } from '../../ports/clock';
import { cryptoRandomBytes } from '../../ports/id-generator';
import type { SourceReader } from '../../ports/source-reader';
import type { ExportContext, LocationCatalog, ToolExporter } from '../../ports/tool-adapter';
import type { LinkCapability, WriteGate } from '../../ports/write-gate';
import type { LibraryService } from '../library/library-service';

/**
 * Serwis eksportu (ARCHITECTURE 3.5). Plan zyje tylko w main pod `planId`: `apply` bierze go z
 * mapy, nie z renderera, i zuzywa przy pierwszej probie. Serwis nie zna sciezek bezwzglednych.
 */

export type ExportErrorCode =
  | 'unsupported-tool'
  | 'no-items'
  | 'unknown-plan'
  | 'plan-expired'
  | 'plan-not-applicable'
  | 'not-approved'
  /** Odmowa `WriteGate` przed zapisem, np. `gate-plan-changed`. */
  | `gate-${string}`;

export class ExportError extends Error {
  constructor(
    readonly code: ExportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExportError';
  }
}

/**
 * Obserwator udanych zapisow (Etap 5): zapisuje stan synchronizacji po kazdym `export:apply`,
 * tez tym z planu cofniecia. Blad obserwatora nie zmienia wyniku zapisu, ktory juz sie odbyl.
 */
export interface ApplyObserver {
  applied(report: ExportPlanReport, result: ExportApplyReport): Promise<void>;
}

export interface ExportServiceDeps {
  readonly catalog: LocationCatalog;
  readonly exporters: readonly ToolExporter[];
  readonly reader: SourceReader;
  readonly library: Pick<LibraryService, 'get'>;
  readonly gate: WriteGate;
  /** Wykryta zdolnosc dowiazan; wynik jest brany przy kazdym planie. */
  readonly links: () => Promise<LinkCapability>;
  readonly clock: Clock;
  readonly ttlMs?: number;
  readonly newPlanId?: () => string;
  readonly observer?: ApplyObserver;
  /** Szew na log bledu zapisu; komunikat dla uzytkownika jest ogolny. */
  readonly onUnexpected?: (error: unknown) => void;
}

export const PLAN_TTL_MS = 15 * 60 * 1000;
export const MAX_PLAN_ITEMS = 500;
const MAX_PLANS = 8;
const APPLY_FAILURE = 'Zapis nie powiódł się. Szczegóły są w logu aplikacji.';

/** Rozpoznanie po ksztalcie, bo core nie importuje klasy `WriteGateRefusal` z infra. */
function isGateRefusal(error: unknown): error is { code: string; message: string } {
  return (
    error instanceof Error &&
    error.name === 'WriteGateRefusal' &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

export interface PlannedItem {
  readonly itemId: ItemId;
  readonly kind: LoadedItem['item']['kind'];
  readonly slug: string;
  readonly title: string;
  /** Rewizja i hash tresci elementu w chwili planu: podstawa stanu synchronizacji. */
  readonly revision: number;
  readonly contentHash: Sha256;
}

export interface ExportPlanReport {
  readonly planId: string;
  readonly tool: ToolId;
  readonly toolMissing: boolean;
  readonly plan: WritePlan;
  readonly items: readonly PlannedItem[];
  /** Etykiety rootow tego narzedzia, po `rootId`. */
  readonly rootLabels: ReadonlyMap<string, string>;
  /** Stabilne w obrebie planu: `e1`, `e2`, ... w kolejnosci wpisow. */
  readonly entryIds: readonly string[];
}

export interface ExportApplyReport {
  readonly planId: string;
  readonly backupId: string;
  readonly entries: readonly {
    entryId: string;
    outcome: ApplyReport['entries'][number]['outcome'];
    message: string | null;
  }[];
  readonly verified: boolean;
  readonly rolledBack: boolean;
}

interface StoredPlan {
  readonly expiresAt: number;
  readonly report: ExportPlanReport;
}

function defaultPlanId(): string {
  return Array.from(cryptoRandomBytes(18), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function materializationFor(links: LinkCapability): ExportContext['materialization'] {
  return {
    directory: links.directorySymlink ? 'symlink' : links.junction ? 'junction' : 'copy',
    file: links.fileSymlink ? 'symlink' : 'copy',
  };
}

/** Wycina z komunikatu bramki wszystko, co wyglada na sciezke bezwzgledna. */
export function redactPaths(message: string): string {
  return message.replace(/(^|[\s"'(])(\/[^\s"')]+|[A-Za-z]:\\[^\s"')]+)/g, '$1<sciezka>');
}

export class ExportService {
  private readonly plans = new Map<string, StoredPlan>();
  private readonly exporters: ReadonlyMap<ToolId, ToolExporter>;
  private readonly ttlMs: number;
  private readonly newPlanId: () => string;

  constructor(private readonly deps: ExportServiceDeps) {
    this.exporters = new Map(deps.exporters.map((e) => [e.id, e]));
    this.ttlMs = deps.ttlMs ?? PLAN_TTL_MS;
    this.newPlanId = deps.newPlanId ?? defaultPlanId;
  }

  async plan(tool: ToolId, itemIds: readonly string[]): Promise<ExportPlanReport> {
    const report = await this.preview(tool, itemIds);
    if (!report.toolMissing) this.remember(report);
    return report;
  }

  /** Jak `plan`, ale plan nie jest zapamietany: do odczytu stanu (sieroty, status) bez wypierania planow. */
  async preview(tool: ToolId, itemIds: readonly string[]): Promise<ExportPlanReport> {
    const exporter = this.exporters.get(tool);
    if (exporter === undefined) {
      throw new ExportError(
        'unsupported-tool',
        'Eksport do tego narzędzia nie jest jeszcze dostępny.',
      );
    }
    const wanted = [...new Set(itemIds)];
    if (wanted.length === 0 || wanted.length > MAX_PLAN_ITEMS) {
      throw new ExportError('no-items', 'Wybierz od jednego do kilkuset elementów do eksportu.');
    }

    const loaded: LoadedItem[] = [];
    for (const id of wanted) loaded.push(await this.deps.library.get(id));
    const items: PlannedItem[] = loaded.map(({ item }) => ({
      itemId: item.id,
      kind: item.kind,
      slug: item.identity.slug,
      title: item.content.title,
      revision: item.version.revision,
      contentHash: item.version.contentHash,
    }));

    const roots = (await this.deps.catalog.detect()).filter((r) => r.tool === tool);
    const rootLabels = new Map(roots.map((r) => [r.rootId, r.label]));
    const planId = this.newPlanId();
    const now = this.deps.clock.now().toISOString();

    // Narzedzia nie ma na dysku: eksport odmowiony w calosci (decyzja 2026-11-03).
    if (!(await this.deps.catalog.toolHomeExists(tool))) {
      const empty: WritePlan = {
        planId,
        tool,
        createdAt: now,
        entries: [],
        verdicts: [],
        refusals: [],
        conflicts: [],
        orphans: [],
        applicable: false,
      };
      return { planId, tool, toolMissing: true, plan: empty, items, rootLabels, entryIds: [] };
    }

    const ctx: ExportContext = {
      roots,
      reader: this.deps.reader,
      materialization: materializationFor(await this.deps.links()),
    };
    const drafted = await exporter.plan(loaded, ctx);
    const probed = await this.deps.gate.probe({ ...drafted, planId, tool });
    const plan: WritePlan = { ...probed, planId };

    const report: ExportPlanReport = {
      planId,
      tool,
      toolMissing: false,
      plan,
      items,
      rootLabels,
      entryIds: plan.entries.map((_e, i) => `e${i + 1}`),
    };
    return report;
  }

  /**
   * Przyjmuje plan zbudowany poza eksporterami (cofniecie z kopii): sonduje go bramka i zapamietuje
   * pod nowym `planId`, wiec dalej idzie zwyklym `apply` z jawnym zatwierdzeniem.
   */
  async adopt(draft: WritePlan, items: readonly PlannedItem[] = []): Promise<ExportPlanReport> {
    const roots = (await this.deps.catalog.detect()).filter((r) => r.tool === draft.tool);
    const rootLabels = new Map(roots.map((r) => [r.rootId, r.label]));
    const planId = this.newPlanId();
    if (!(await this.deps.catalog.toolHomeExists(draft.tool))) {
      const plan: WritePlan = { ...draft, planId, applicable: false };
      return {
        planId,
        tool: draft.tool,
        toolMissing: true,
        plan,
        items,
        rootLabels,
        entryIds: plan.entries.map((_e, i) => `e${i + 1}`),
      };
    }
    const probed = await this.deps.gate.probe({ ...draft, planId });
    const plan: WritePlan = { ...probed, planId };
    const report: ExportPlanReport = {
      planId,
      tool: draft.tool,
      toolMissing: false,
      plan,
      items,
      rootLabels,
      entryIds: plan.entries.map((_e, i) => `e${i + 1}`),
    };
    this.remember(report);
    return report;
  }

  async apply(planId: string, approved: boolean): Promise<ExportApplyReport> {
    if (!approved) {
      throw new ExportError('not-approved', 'Zapis wymaga jawnego zatwierdzenia planu.');
    }
    const stored = this.plans.get(planId);
    if (stored === undefined) {
      throw new ExportError('unknown-plan', 'Nieznany plan. Przygotuj plan eksportu jeszcze raz.');
    }
    // Plan jest jednorazowy: zuzyty przy kazdej probie, takze nieudanej.
    this.plans.delete(planId);
    if (this.deps.clock.now().getTime() > stored.expiresAt) {
      throw new ExportError('plan-expired', 'Plan wygasł. Przygotuj plan eksportu jeszcze raz.');
    }
    const { plan, entryIds } = stored.report;
    if (!plan.applicable) {
      throw new ExportError(
        'plan-not-applicable',
        'Tego planu nie da się zastosować. Usuń blokady i przygotuj plan jeszcze raz.',
      );
    }

    const report = await this.deps.gate.apply(plan, { planId }).catch((error: unknown) => {
      // Odmowa bramki zapada przed pierwszym zapisem, wiec to odmowa z powodem, nie nieudany zapis.
      if (isGateRefusal(error)) {
        throw new ExportError(`gate-${error.code}`, redactPaths(error.message));
      }
      this.deps.onUnexpected?.(error);
      return null;
    });
    if (report === null) {
      return {
        planId,
        backupId: '',
        entries: plan.entries.map((_e, i) => ({
          entryId: entryIds[i] ?? `e${i + 1}`,
          outcome: 'failed' as const,
          message: APPLY_FAILURE,
        })),
        verified: false,
        rolledBack: false,
      };
    }

    const idByKey = new Map(
      plan.entries.map((e, i) => [key(e.rootId, e.relPath), entryIds[i] ?? '']),
    );
    const result: ExportApplyReport = {
      planId,
      backupId: report.backupId,
      entries: report.entries.map((e) => ({
        entryId: idByKey.get(key(e.rootId, e.relPath)) ?? '',
        outcome: e.outcome,
        message: e.message === null ? null : redactPaths(e.message),
      })),
      verified: report.verified,
      rolledBack: report.rolledBack,
    };
    // Zapis sie odbyl; nieudana notatka o stanie synchronizacji nie moze go zamienic w blad.
    await this.deps.observer?.applied(stored.report, result).catch((error: unknown) => {
      this.deps.onUnexpected?.(error);
    });
    return result;
  }

  private remember(report: ExportPlanReport): void {
    const nowMs = this.deps.clock.now().getTime();
    for (const [id, stored] of this.plans) if (stored.expiresAt < nowMs) this.plans.delete(id);
    while (this.plans.size >= MAX_PLANS) {
      const oldest = this.plans.keys().next().value;
      if (oldest === undefined) break;
      this.plans.delete(oldest);
    }
    this.plans.set(report.planId, { expiresAt: nowMs + this.ttlMs, report });
  }
}

function key(rootId: string, relPath: string): string {
  return `${rootId}\0${relPath}`;
}
