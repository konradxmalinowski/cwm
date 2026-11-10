import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';

import type { ExportPlanDto } from '../../../../shared/ipc/export-contract';
import type { ToolIdDto } from '../../../../shared/ipc/import-contract';
import type {
  SyncApplyDto,
  SyncPlanDto,
  SyncResolutionDto,
  SyncStateDto,
  SyncStatusDto,
} from '../../../../shared/ipc/sync-contract';
import { SyncApiService } from '../../core/ipc/sync-api.service';
import { handleRowNavKey } from '../../core/keyboard/row-nav';
import { formatDate, kindLabel, plural } from '../../core/labels';
import { ROUTES } from '../../core/routing/route';
import { ApplyResultComponent } from '../export/apply-result.component';
import { DiffViewComponent } from '../export/diff-view.component';
import { ExportConfirmDialogComponent } from '../export/export-confirm-dialog.component';
import {
  EMPTY_COUNTS,
  addCounts,
  blockers,
  countPlan,
  HIDDEN_SECRET_NOTE,
  diffPair,
  entryKind,
  hasHiddenSecret,
  type PlanCounts,
} from '../export/export-model';
import { PlanStatsComponent } from '../export/plan-stats.component';
import { PlanViewComponent } from '../export/plan-view.component';
import { joinRootPath, toolLabel } from '../import/import-model';
import {
  MATERIALIZATION_NAME,
  RESOLUTIONS,
  STATES,
  STATE_ORDER,
  buildMatrix,
  resolutionKey,
  rowMatchesState,
  toolsInUse,
  totals,
  type MatrixRow,
} from './sync-model';

type StatusState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly data: SyncStatusDto };

type Phase = 'status' | 'planning' | 'plan' | 'applying' | 'result';

type Preview =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly plan: SyncPlanDto };

@Component({
  selector: 'app-sync-center',
  imports: [
    ApplyResultComponent,
    DiffViewComponent,
    ExportConfirmDialogComponent,
    PlanStatsComponent,
    PlanViewComponent,
  ],
  templateUrl: './sync-center.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'onKeydown($event)' },
})
export class SyncCenterComponent {
  private readonly api = inject(SyncApiService);

  protected readonly libraryHref = `#${ROUTES.library}`;
  protected readonly importHref = `#${ROUTES.import}`;
  protected readonly historyHref = `#${ROUTES.history}`;

  protected readonly states = STATES;
  protected readonly stateOrder = STATE_ORDER;
  protected readonly resolutions = RESOLUTIONS;
  protected readonly materializationName = MATERIALIZATION_NAME;
  protected readonly kindLabel = kindLabel;
  protected readonly toolLabel = toolLabel;
  protected readonly plural = plural;
  protected readonly formatDate = formatDate;
  protected readonly diffPair = diffPair;
  protected readonly secretNote = HIDDEN_SECRET_NOTE;
  protected readonly hasHiddenSecret = hasHiddenSecret;
  protected readonly entryKind = entryKind;

  protected readonly phase = signal<Phase>('status');
  protected readonly statusState = signal<StatusState>({ status: 'loading' });
  protected readonly refreshing = signal(false);
  protected readonly query = signal('');
  protected readonly stateFilter = signal<SyncStateDto | ''>('');
  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  protected readonly choices = signal<ReadonlyMap<string, SyncResolutionDto>>(new Map());
  protected readonly previews = signal<ReadonlyMap<string, Preview>>(new Map());
  protected readonly plan = signal<SyncPlanDto | null>(null);
  protected readonly planError = signal<string | null>(null);
  protected readonly applyError = signal<string | null>(null);
  protected readonly result = signal<SyncApplyDto | null>(null);
  protected readonly confirming = signal(false);

  private seq = 0;
  private statusSeq = 0;

  protected readonly data = computed(() => {
    const state = this.statusState();
    return state.status === 'ready' ? state.data : null;
  });

  protected readonly allRows = computed(() => buildMatrix(this.data()?.items ?? []));
  protected readonly tools = computed(() => toolsInUse(this.data()?.items ?? []));
  protected readonly missingTools = computed(() => this.data()?.missingTools ?? []);

  /** Narzedzia, do ktorych da sie zapisac: te, ktorych katalog glowny istnieje. */
  protected readonly syncTools = computed(() =>
    this.tools().filter((tool) => !this.missingTools().includes(tool)),
  );

  /** Narzedzia wybrane do zapisu; null oznacza wszystkie dostepne. */
  protected readonly pickedTools = signal<ReadonlySet<ToolIdDto> | null>(null);

  protected readonly planTools = computed(() => {
    const picked = this.pickedTools();
    return this.syncTools().filter((tool) => picked === null || picked.has(tool));
  });

  protected readonly rows = computed(() => {
    const query = this.query().trim().toLocaleLowerCase('pl');
    const state = this.stateFilter();
    return this.allRows().filter(
      (row) =>
        rowMatchesState(row, state) &&
        (query === '' ||
          row.title.toLocaleLowerCase('pl').includes(query) ||
          row.slug.toLocaleLowerCase('pl').includes(query)),
    );
  });

  protected readonly filtered = computed(
    () => this.query().trim() !== '' || this.stateFilter() !== '',
  );
  protected readonly totals = computed(() => totals(this.allRows()));
  protected readonly selectedCount = computed(() => this.selected().size);

  protected readonly allVisibleSelected = computed(
    () => this.rows().length > 0 && this.rows().every((row) => this.selected().has(row.itemId)),
  );

  protected readonly canPlan = computed(
    () => this.phase() === 'status' && this.selectedCount() > 0 && this.planTools().length > 0,
  );

  private readonly titlesById = computed(
    () => new Map(this.allRows().map((row) => [row.itemId, row.title])),
  );

  protected readonly planTitles = computed(() => this.titlesById());

  protected readonly planCounts = computed<PlanCounts>(() => {
    const plan = this.plan();
    if (plan === null) return EMPTY_COUNTS;
    return plan.plans.map(countPlan).reduce(addCounts, EMPTY_COUNTS);
  });

  protected readonly planBlockers = computed(() => {
    const plan = this.plan();
    if (plan === null || plan.applicable) return [];
    const reasons: string[] = [];
    for (const p of plan.plans) {
      const counts = countPlan(p);
      if (p.toolMissing || p.conflicts.length > 0 || counts.blocked > 0) {
        for (const reason of blockers(p, counts)) reasons.push(`${toolLabel(p.tool)}: ${reason}`);
      }
    }
    if (reasons.length === 0) {
      reasons.push(
        this.planCounts().changes === 0 && plan.adoptions.length === 0
          ? 'Nic nie wymaga zapisu: wybrane elementy są już zgodne albo czekają na Twoją decyzję.'
          : 'Plan nie nadaje się do zapisu.',
      );
    }
    return reasons;
  });

  protected readonly sentence = computed(() => {
    switch (this.phase()) {
      case 'status': {
        const state = this.statusState();
        if (state.status === 'loading') return 'Wczytuję stan synchronizacji.';
        if (state.status === 'error') return 'Nie udało się wczytać stanu synchronizacji.';
        if (this.allRows().length === 0)
          return 'Nie ma czego synchronizować, bo biblioteka jest pusta.';
        const t = this.totals();
        if (t.pending === 0 && t.decisions === 0)
          return 'Biblioteka i narzędzia są zgodne z ostatnią synchronizacją.';
        const parts: string[] = [];
        if (t.decisions > 0)
          parts.push(
            `${t.decisions} ${plural(t.decisions, 'zmiana wymaga', 'zmiany wymagają', 'zmian wymaga')} Twojej decyzji`,
          );
        if (t.pending > 0)
          parts.push(
            `${t.pending} ${plural(t.pending, 'element czeka', 'elementy czekają', 'elementów czeka')} na zapis`,
          );
        const sentence = parts.join(', ');
        return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
      }
      case 'planning':
        return 'Przygotowuję plan synchronizacji. Niczego jeszcze nie zapisuję.';
      case 'plan': {
        const plan = this.plan();
        if (plan === null) return '';
        const c = this.planCounts();
        const adopted = plan.adoptions.length;
        if (!plan.applicable) {
          if (plan.plans.some((p) => p.conflicts.length > 0))
            return 'Plan ma konflikty, więc nie da się go zapisać.';
          if (plan.plans.some((p) => p.toolMissing))
            return 'Brakuje katalogu narzędzia, więc nie da się zapisać planu.';
          if (c.blocked > 0) return 'Część plików jest zablokowana, więc nie da się zapisać planu.';
          return 'Z tego wyboru nie wynika żadna zmiana.';
        }
        const parts: string[] = [];
        if (c.changes > 0)
          parts.push(
            `zmieni ${c.changes} ${plural(c.changes, 'plik', 'pliki', 'plików')} w ${plan.plans.length} ${plural(plan.plans.length, 'narzędziu', 'narzędziach', 'narzędziach')}`,
          );
        if (adopted > 0)
          parts.push(
            `przyjmie ${adopted} ${plural(adopted, 'zmianę', 'zmiany', 'zmian')} z narzędzi do biblioteki`,
          );
        return `Synchronizacja ${parts.join(' i ')}.`;
      }
      case 'applying':
        return 'Synchronizuję. Nie zamykaj aplikacji, dopóki zapis się nie skończy.';
      case 'result': {
        const r = this.result();
        if (r === null) return '';
        if (r.results.some((x) => !x.rolledBack && x.entries.some((e) => e.outcome === 'failed')))
          return 'Zapis się nie udał, a aplikacja nie przywróciła w pełni poprzedniego stanu plików.';
        if (r.results.some((x) => x.rolledBack))
          return 'Zapis się nie udał, a aplikacja przywróciła poprzedni stan plików.';
        const written = r.results.reduce(
          (n, x) => n + x.entries.filter((e) => e.outcome === 'written').length,
          0,
        );
        const adopted = r.adopted.filter((a) => a.ok).length;
        const failedAdopt = r.adopted.length - adopted;
        const parts: string[] = [];
        if (written > 0)
          parts.push(`zapisano ${written} ${plural(written, 'plik', 'pliki', 'plików')}`);
        if (adopted > 0)
          parts.push(
            `przyjęto ${adopted} ${plural(adopted, 'zmianę', 'zmiany', 'zmian')} do biblioteki`,
          );
        if (failedAdopt > 0)
          parts.push(
            `${failedAdopt} ${plural(failedAdopt, 'zmiana nie trafiła', 'zmiany nie trafiły', 'zmian nie trafiło')} do biblioteki`,
          );
        if (parts.length === 0) return 'Nic nie zostało zmienione.';
        const sentence = parts.join(', ');
        return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
      }
    }
  });

  protected readonly stepLabel = computed(() => {
    switch (this.phase()) {
      case 'status':
      case 'planning':
        return '5. Synchronizacja, krok 1 z 3: wybór';
      case 'plan':
      case 'applying':
        return '5. Synchronizacja, krok 2 z 3: plan';
      case 'result':
        return '5. Synchronizacja, krok 3 z 3: wynik';
    }
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.seq++;
      this.statusSeq++;
    });

    // Po zmianie kroku fokus idzie na zdanie, zeby czytnik ekranu i klawiatura wiedzialy, ze tresc sie zmienila.
    let first = true;
    effect(() => {
      this.phase();
      if (first) {
        first = false;
        return;
      }
      setTimeout(() => document.getElementById('sync-heading')?.focus(), 0);
    });

    void this.loadStatus();
  }

  // ---- Krok 1: stan ----

  protected async loadStatus(): Promise<void> {
    const seq = ++this.statusSeq;
    this.refreshing.set(true);
    const result = await this.api.status({});
    if (seq !== this.statusSeq) return;
    this.refreshing.set(false);
    if (!result.ok) {
      this.statusState.set({ status: 'error', message: result.error.message });
      return;
    }
    this.statusState.set({ status: 'ready', data: result.value });
    // Wybor sprzed odswiezenia zostaje tylko dla elementow, ktore nadal istnieja.
    const known = new Set(result.value.items.map((i) => i.itemId));
    const kept = Array.from(this.selected()).filter((id) => known.has(id));
    if (kept.length !== this.selected().size) this.selected.set(new Set(kept));
  }

  protected retry(): void {
    this.statusState.set({ status: 'loading' });
    void this.loadStatus();
  }

  protected onQuery(value: string): void {
    this.query.set(value);
  }

  protected onStateFilter(value: string): void {
    this.stateFilter.set(value as SyncStateDto | '');
  }

  protected clearFilters(): void {
    this.query.set('');
    this.stateFilter.set('');
  }

  protected toolPicked(tool: ToolIdDto): boolean {
    return this.planTools().includes(tool);
  }

  protected toggleTool(tool: ToolIdDto, checked: boolean): void {
    const next = new Set(this.planTools());
    if (checked) next.add(tool);
    else next.delete(tool);
    this.pickedTools.set(next);
  }

  protected toggleRow(itemId: string, checked: boolean): void {
    const next = new Set(this.selected());
    if (checked) next.add(itemId);
    else next.delete(itemId);
    this.selected.set(next);
  }

  protected selectAllVisible(): void {
    const next = new Set(this.selected());
    for (const row of this.rows()) next.add(row.itemId);
    this.selected.set(next);
  }

  protected clearSelection(): void {
    this.selected.set(new Set());
  }

  protected itemHref(id: string): string {
    return `#${ROUTES.libraryItem(id)}`;
  }

  protected needsDecision(status: SyncStateDto): boolean {
    return STATES[status].needsDecision;
  }

  protected choiceOf(itemId: string, tool: ToolIdDto): SyncResolutionDto {
    return this.choices().get(resolutionKey(itemId, tool)) ?? 'skip';
  }

  protected choose(itemId: string, tool: ToolIdDto, value: SyncResolutionDto): void {
    const next = new Map(this.choices());
    next.set(resolutionKey(itemId, tool), value);
    this.choices.set(next);
    // Wybor rozstrzygniecia oznacza, ze uzytkownik chce ten element w przebiegu.
    if (value !== 'skip' && !this.selected().has(itemId)) this.toggleRow(itemId, true);
  }

  protected overwrites(row: MatrixRow): boolean {
    if (!this.selected().has(row.itemId)) return false;
    for (const [tool, cell] of row.cells) {
      if (this.needsDecision(cell.status) && this.choiceOf(row.itemId, tool) === 'library-wins')
        return true;
    }
    return false;
  }

  protected undecided(row: MatrixRow, tool: ToolIdDto): boolean {
    const cell = row.cells.get(tool);
    return (
      cell !== undefined &&
      this.selected().has(row.itemId) &&
      this.needsDecision(cell.status) &&
      this.choiceOf(row.itemId, tool) === 'skip'
    );
  }

  // ---- Podglad roznicy ----

  protected previewOf(itemId: string, tool: ToolIdDto): Preview | undefined {
    return this.previews().get(resolutionKey(itemId, tool));
  }

  protected rowHasPreview(row: MatrixRow): boolean {
    return this.tools().some((tool) => this.previewOf(row.itemId, tool) !== undefined);
  }

  protected previewEntries(plan: SyncPlanDto) {
    return plan.plans
      .flatMap((p) => p.entries)
      .filter((entry) => !['unchanged', 'link', 'restore-link'].includes(entryKind(entry)));
  }

  protected entryPath(entry: { rootLabel: string; relPath: string }): string {
    return joinRootPath(entry.rootLabel, entry.relPath);
  }

  protected togglePreview(itemId: string, tool: ToolIdDto): void {
    const key = resolutionKey(itemId, tool);
    const next = new Map(this.previews());
    if (next.has(key)) {
      next.delete(key);
      this.previews.set(next);
      return;
    }
    next.set(key, { status: 'loading' });
    this.previews.set(next);
    void this.loadPreview(itemId, tool, key);
  }

  private async loadPreview(itemId: string, tool: ToolIdDto, key: string): Promise<void> {
    // Roznica to plan z wersja z biblioteki: "przed" jest plik w narzedziu, "po" wersja z biblioteki.
    const result = await this.api.plan({
      tools: [tool],
      itemIds: [itemId],
      resolutions: [{ itemId, tool, resolution: 'library-wins' }],
    });
    if (!this.previews().has(key)) return;
    const next = new Map(this.previews());
    next.set(
      key,
      result.ok
        ? { status: 'ready', plan: result.value }
        : { status: 'error', message: result.error.message },
    );
    this.previews.set(next);
  }

  // ---- Krok 1 -> 2 ----

  protected async preparePlan(): Promise<void> {
    if (!this.canPlan()) return;
    const seq = ++this.seq;
    this.planError.set(null);
    this.phase.set('planning');
    const itemIds = [...this.selected()];
    const resolutions = [...this.choices().entries()]
      .map(([key, resolution]) => {
        const [itemId, tool] = key.split('|') as [string, ToolIdDto];
        return { itemId, tool, resolution };
      })
      .filter((r) => this.selected().has(r.itemId) && this.planTools().includes(r.tool));
    const result = await this.api.plan({
      tools: [...this.planTools()],
      itemIds,
      ...(resolutions.length > 0 ? { resolutions } : {}),
    });
    if (seq !== this.seq) return;
    if (!result.ok) {
      this.planError.set(result.error.message);
      this.phase.set('status');
      return;
    }
    this.plan.set(result.value);
    this.applyError.set(null);
    this.phase.set('plan');
  }

  protected cancelPlanning(): void {
    this.seq++;
    this.phase.set('status');
  }

  // ---- Krok 2 ----

  protected backToSelection(): void {
    this.seq++;
    this.plan.set(null);
    this.applyError.set(null);
    this.confirming.set(false);
    this.phase.set('status');
  }

  /** Plan jest jednorazowy: po nieudanym zapisie trzeba go przygotowac od nowa z tym samym wyborem. */
  protected replan(): void {
    this.backToSelection();
    void this.preparePlan();
  }

  protected planToolName(plan: ExportPlanDto): string {
    return toolLabel(plan.tool);
  }

  protected skippedTitle(itemId: string): string {
    return this.titlesById().get(itemId) ?? 'Element spoza biblioteki';
  }

  protected openConfirm(): void {
    const plan = this.plan();
    if (plan === null || !plan.applicable || this.phase() !== 'plan') return;
    this.confirming.set(true);
  }

  protected cancelConfirm(): void {
    this.confirming.set(false);
  }

  protected async apply(): Promise<void> {
    const plan = this.plan();
    this.confirming.set(false);
    if (plan === null || !plan.applicable || this.phase() !== 'plan') return;
    const seq = ++this.seq;
    this.applyError.set(null);
    this.phase.set('applying');
    const result = await this.api.apply({ syncId: plan.syncId, approved: true });
    if (seq !== this.seq) return;
    if (!result.ok) {
      this.applyError.set(result.error.message);
      this.phase.set('plan');
      return;
    }
    this.result.set(result.value);
    this.phase.set('result');
  }

  // ---- Krok 3 ----

  protected planFor(planId: string): ExportPlanDto | null {
    return this.plan()?.plans.find((p) => p.planId === planId) ?? null;
  }

  protected resultToolName(planId: string): string {
    const plan = this.planFor(planId);
    return plan === null ? 'Narzędzie' : toolLabel(plan.tool);
  }

  protected adoptedFailed(): boolean {
    return (this.result()?.adopted ?? []).some((a) => !a.ok);
  }

  protected restart(): void {
    this.seq++;
    this.plan.set(null);
    this.result.set(null);
    this.applyError.set(null);
    this.planError.set(null);
    this.selected.set(new Set());
    this.choices.set(new Map());
    this.previews.set(new Map());
    this.pickedTools.set(null);
    this.confirming.set(false);
    this.phase.set('status');
    this.statusState.set({ status: 'loading' });
    void this.loadStatus();
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (this.phase() !== 'status' || this.statusState().status !== 'ready') return;
    handleRowNavKey(event, '[data-sync-nav]', 'sync-query');
  }
}
