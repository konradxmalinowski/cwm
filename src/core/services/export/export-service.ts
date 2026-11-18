import type { ItemId, LoadedItem, Sha256, ToolId } from '../../model/item';
import type { ApplyReport, ExportDecision, WritePlan } from '../../model/plan';
import type { Clock } from '../../ports/clock';
import { cryptoRandomBytes } from '../../ports/id-generator';
import type { SourceReader } from '../../ports/source-reader';
import type { ProjectRootCatalog } from '../../ports/project-roots';
import type {
  DetectedRoot,
  ExportContext,
  LocationCatalog,
  ToolExporter,
} from '../../ports/tool-adapter';
import type { LinkCapability, WriteGate } from '../../ports/write-gate';
import type { LibraryService } from '../library/library-service';
import { isMcpServerItem, mcpPreview, type McpPreview } from '../mcp/mcp-server';
import {
  GLOBAL_TARGET,
  boundProject,
  restrictedFromRepository,
  scopeRefusal,
  type ExportTarget,
} from './project-scope';

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
  /** Biblioteka albo katalog lokalizacji nie sa jeszcze przygotowane (eksport do ZIP). */
  | 'export-unavailable'
  /** Odmowa przy budowie archiwum ZIP (ADR 0054), np. `zip-too-large`. */
  | `zip-${string}`
  /** Odmowa `WriteGate` przed zapisem, np. `gate-plan-changed`. */
  | `gate-${string}`
  /** Cel "projekt" (ADR 0059): projekt nieznany, katalog niewazny albo rejestr niedostepny. */
  | 'unknown-project'
  | 'project-invalid'
  | 'project-unavailable'
  /** Plan zapisuje serwer MCP, a zapis nie ma potwierdzenia z podgladu (ADR 0061). */
  | 'mcp-confirmation-required';

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
  /** Rooty projektow (ADR 0059). Brak portu: cel "projekt" jest niedostepny. */
  readonly projects?: ProjectRootCatalog;
  readonly exporters: readonly ToolExporter[];
  /** Czytnik musi rozwiazywac rooty globalne i projektowe. */
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
  /** Projekt, do ktorego element jest przypiety; `null` dla elementu globalnego (ADR 0059). */
  readonly projectId: string | null;
  /** Prywatny albo z trafieniem sekretow: nie trafia do repozytorium jako element globalny (ADR 0059). */
  readonly restricted: boolean;
  /** Serwer MCP (ADR 0061): zapis wymaga osobnego potwierdzenia z podgladem. */
  readonly mcp?: boolean;
}

/** Cel planu: katalog globalny narzedzia albo projekt z rejestru (ADR 0059). */
export type PlanTarget =
  | { readonly kind: 'global' }
  | {
      readonly kind: 'project';
      readonly projectId: string;
      readonly name: string;
      readonly includeGlobal: boolean;
    };

export interface ExportPlanReport {
  readonly planId: string;
  readonly tool: ToolId;
  readonly target: PlanTarget;
  readonly toolMissing: boolean;
  readonly plan: WritePlan;
  readonly items: readonly PlannedItem[];
  /** Etykiety rootow tego narzedzia, po `rootId`. */
  readonly rootLabels: ReadonlyMap<string, string>;
  /** Stabilne w obrebie planu: `e1`, `e2`, ... w kolejnosci wpisow. */
  readonly entryIds: readonly string[];
  /**
   * Serwery MCP, ktore plan zapisze (wpisy inne niz `unchanged`), z poleceniem albo adresem i nazwami
   * zmiennych, bez wartosci. Niepusta lista oznacza, ze `apply` wymaga potwierdzenia (ADR 0061).
   */
  readonly mcp?: readonly McpPreview[];
}

export interface ExportApplyOptions {
  /** Main sprawdzil jednorazowy znacznik z podgladu serwerow MCP tego planu. */
  readonly mcpConfirmed?: boolean;
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

  async plan(
    tool: ToolId,
    itemIds: readonly string[],
    decisions: readonly ExportDecision[] = [],
    target: ExportTarget = GLOBAL_TARGET,
  ): Promise<ExportPlanReport> {
    const report = await this.preview(tool, itemIds, decisions, target);
    this.retain(report);
    return report;
  }

  /**
   * Zapamietuje plan z `preview` pod jego `planId`, zeby `apply` mogl go uzyc. Kanal `export:plan`
   * wola to dopiero po kontroli zakresu w main (ADR 0059): plan odrzucony tam nie istnieje w serwisie.
   */
  retain(report: ExportPlanReport): void {
    if (!report.toolMissing) this.remember(report);
  }

  /** Jak `plan`, ale plan nie jest zapamietany: do odczytu stanu (sieroty, status) bez wypierania planow. */
  async preview(
    tool: ToolId,
    itemIds: readonly string[],
    decisions: readonly ExportDecision[] = [],
    target: ExportTarget = GLOBAL_TARGET,
  ): Promise<ExportPlanReport> {
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
      projectId: boundProject(item),
      restricted: restrictedFromRepository(item),
      mcp: isMcpServerItem(item),
    }));

    const destination = await this.destination(tool, target);
    const { roots, planTarget } = destination;
    const rootLabels = new Map(roots.map((r) => [r.rootId, r.label]));
    const planId = this.newPlanId();
    const now = this.deps.clock.now().toISOString();

    // Narzedzia nie ma na dysku: eksport odmowiony w calosci (decyzja 2026-11-03). Projekt ma
    // katalog sprawdzony przez rejestr, wiec ten warunek go nie dotyczy (ADR 0059).
    if (planTarget.kind === 'global' && !(await this.deps.catalog.toolHomeExists(tool))) {
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
      return {
        planId,
        tool,
        target: planTarget,
        toolMissing: true,
        plan: empty,
        items,
        rootLabels,
        entryIds: [],
      };
    }

    // Zakres egzekwowany przed eksporterem: element spoza celu nie dostaje nawet planu (ADR 0059).
    const allowed: LoadedItem[] = [];
    const refusals: WritePlan['refusals'][number][] = [];
    for (const one of loaded) {
      const reason = scopeRefusal(one.item, target);
      if (reason === null) allowed.push(one);
      else
        refusals.push({
          itemId: one.item.id,
          kind: one.item.kind,
          slug: one.item.identity.slug,
          reason,
        });
    }

    let drafted: WritePlan;
    if (allowed.length === 0) {
      drafted = {
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
    } else {
      // Do repozytorium projektu idzie zawsze kopia: dowiazanie do katalogu danych aplikacji
      // trafiloby do Gita jako sciezka z tego komputera (ADR 0059).
      const materialization =
        planTarget.kind === 'project'
          ? { directory: 'copy' as const, file: 'copy' as const }
          : materializationFor(await this.deps.links());
      const ctx: ExportContext = {
        roots,
        reader: this.deps.reader,
        ...(decisions.length === 0 ? {} : { decisions }),
        materialization,
      };
      drafted = await exporter.plan(allowed, ctx);
    }
    const scoped: WritePlan = { ...drafted, refusals: [...refusals, ...drafted.refusals] };
    const probed = await this.deps.gate.probe({ ...scoped, planId, tool });
    const plan: WritePlan = { ...probed, planId };

    const report: ExportPlanReport = {
      planId,
      tool,
      target: planTarget,
      toolMissing: false,
      plan,
      items,
      rootLabels,
      entryIds: plan.entries.map((_e, i) => `e${i + 1}`),
      mcp: mcpWrites(plan, loaded, tool),
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
    // Cofniecie zapisu do projektu: etykiety i cel z rejestru projektow, bez warunku katalogu narzedzia.
    let target: PlanTarget = { kind: 'global' };
    for (const entry of draft.entries) {
      const owner = this.deps.projects?.ownerOf(entry.rootId) ?? null;
      if (owner === null) continue;
      rootLabels.set(entry.rootId, owner.label);
      if (target.kind === 'global') {
        target = { kind: 'project', projectId: owner.projectId, name: '', includeGlobal: true };
      }
    }
    const planId = this.newPlanId();
    if (target.kind === 'global' && !(await this.deps.catalog.toolHomeExists(draft.tool))) {
      const plan: WritePlan = { ...draft, planId, applicable: false };
      return {
        planId,
        tool: draft.tool,
        target,
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
      target,
      toolMissing: false,
      plan,
      items,
      rootLabels,
      entryIds: plan.entries.map((_e, i) => `e${i + 1}`),
    };
    this.remember(report);
    return report;
  }

  async apply(
    planId: string,
    approved: boolean,
    options: ExportApplyOptions = {},
  ): Promise<ExportApplyReport> {
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
    // Druga kontrola niezalezna od kanalu: plan z serwerem MCP bez potwierdzenia nie zapisuje niczego,
    // takze wtedy, gdy wola go synchronizacja, ktora MCP i tak pomija (ADR 0061).
    if ((stored.report.mcp?.length ?? 0) > 0 && options.mcpConfirmed !== true) {
      throw new ExportError(
        'mcp-confirmation-required',
        'Plan zapisuje serwer MCP. Potwierdź podgląd serwerów i przygotuj plan jeszcze raz.',
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
    // Stan synchronizacji dotyczy katalogow globalnych; zapis do projektu go nie dotyka (ADR 0059).
    if (stored.report.target.kind === 'global') {
      await this.deps.observer?.applied(stored.report, result).catch((error: unknown) => {
        this.deps.onUnexpected?.(error);
      });
    }
    return result;
  }

  /** Rooty celu: katalog globalny z warstwy lokalizacji albo rooty projektu z rejestru. */
  private async destination(
    tool: ToolId,
    target: ExportTarget,
  ): Promise<{ roots: readonly DetectedRoot[]; planTarget: PlanTarget }> {
    if (target.kind === 'global') {
      const roots = (await this.deps.catalog.detect()).filter((r) => r.tool === tool);
      return { roots, planTarget: { kind: 'global' } };
    }
    const projects = this.deps.projects;
    if (projects === undefined) {
      throw new ExportError(
        'project-unavailable',
        'Eksport do projektu jest niedostępny w tej instalacji.',
      );
    }
    const found = await projects.roots(target.projectId);
    if (!found.ok) throw new ExportError(found.code, found.message);
    return {
      roots: found.roots.filter((r) => r.tool === tool),
      planTarget: {
        kind: 'project',
        projectId: found.projectId,
        name: found.name,
        includeGlobal: target.includeGlobal,
      },
    };
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

/** Serwery MCP z wpisow, ktore cos zapisza; `unchanged` nie wymaga potwierdzenia. */
function mcpWrites(
  plan: WritePlan,
  loaded: readonly LoadedItem[],
  tool: ToolId,
): readonly McpPreview[] {
  const writing = new Set<string>();
  for (const entry of plan.entries) {
    if (entry.action === 'unchanged') continue;
    for (const id of entry.itemIds) writing.add(id);
  }
  const out: McpPreview[] = [];
  for (const { item } of loaded) {
    if (!writing.has(item.id) || !isMcpServerItem(item)) continue;
    const preview = mcpPreview(item, tool);
    if (preview !== null) out.push(preview);
  }
  return out;
}

function key(rootId: string, relPath: string): string {
  return `${rootId}\0${relPath}`;
}
