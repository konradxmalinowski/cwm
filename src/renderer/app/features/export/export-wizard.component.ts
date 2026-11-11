import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';

import type {
  ConflictResolutionDto,
  ExportApplyDto,
  ExportPlanDto,
} from '../../../../shared/ipc/export-contract';
import type { ToolIdDto } from '../../../../shared/ipc/import-contract';
import type { ItemSummaryDto } from '../../../../shared/ipc/library-contract';
import { ExportApiService } from '../../core/ipc/export-api.service';
import { LibraryApiService } from '../../core/ipc/library-api.service';
import { kindLabel, plural } from '../../core/labels';
import { ROUTES } from '../../core/routing/route';
import { ExportSelectionService } from '../../core/state/export-selection.service';
import { toolLabel } from '../import/import-model';
import { ApplyResultComponent } from './apply-result.component';
import { ExportConfirmDialogComponent } from './export-confirm-dialog.component';
import {
  TOOLS,
  blockers,
  conflictKey,
  countPlan,
  decisionKey,
  hasOptions,
  toolLocative,
  type DecisionView,
} from './export-model';
import { PlanViewComponent } from './plan-view.component';

type ItemsState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly items: readonly ItemSummaryDto[]; readonly total: number };

type Phase = 'select' | 'planning' | 'plan' | 'applying' | 'result';

const SEARCH_DEBOUNCE_MS = 250;

@Component({
  selector: 'app-export-wizard',
  imports: [ApplyResultComponent, ExportConfirmDialogComponent, PlanViewComponent],
  templateUrl: './export-wizard.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'onKeydown($event)' },
})
export class ExportWizardComponent {
  private readonly exportApi = inject(ExportApiService);
  private readonly libraryApi = inject(LibraryApiService);
  private readonly selection = inject(ExportSelectionService);

  /** Z trasy `#/eksport/<id>`: element, od ktorego uzytkownik zaczal. */
  readonly itemId = input<string | null>(null);

  protected readonly libraryHref = `#${ROUTES.library}`;
  protected readonly importHref = `#${ROUTES.import}`;
  protected readonly newHref = `#${ROUTES.libraryNew}`;

  protected readonly tools = TOOLS;
  protected readonly kindLabel = kindLabel;
  protected readonly toolLabel = toolLabel;
  protected readonly plural = plural;

  protected readonly phase = signal<Phase>('select');
  protected readonly tool = signal<ToolIdDto | null>(null);
  protected readonly items = signal<ItemsState>({ status: 'loading' });
  protected readonly refreshing = signal(false);
  protected readonly query = signal('');
  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  protected readonly plan = signal<ExportPlanDto | null>(null);
  protected readonly planError = signal<string | null>(null);
  protected readonly applyError = signal<string | null>(null);
  protected readonly result = signal<ExportApplyDto | null>(null);
  protected readonly confirming = signal(false);
  /** Trwa przeliczanie planu po wyborze decyzji: do tego czasu stary plan nie jest wykonywalny. */
  protected readonly replanning = signal(false);
  protected readonly replanError = signal<string | null>(null);

  /** Wybory uzytkownika dla konfliktow z opcjami, po `decisionKey`. */
  private readonly choices = signal<ReadonlyMap<string, ConflictResolutionDto>>(new Map());
  /** Konflikty z opcjami widziane w kolejnych planach; rozstrzygniety konflikt znika z planu, grupa zostaje. */
  private readonly points = signal<ReadonlyMap<string, Omit<DecisionView, 'chosen' | 'settled'>>>(
    new Map(),
  );
  private lastRequest: { tool: ToolIdDto; itemIds: string[] } | null = null;

  private seq = 0;
  private itemsSeq = 0;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private preselect: readonly string[] = [];
  private firstLoadDone = false;

  protected readonly filtered = computed(() => this.query().trim() !== '');

  protected readonly visibleItems = computed(() => {
    const state = this.items();
    return state.status === 'ready' ? state.items : [];
  });

  protected readonly selectedCount = computed(() => this.selected().size);

  protected readonly selectedVisible = computed(
    () => this.visibleItems().filter((item) => this.selected().has(item.id)).length,
  );

  protected readonly hiddenSelected = computed(() => this.selectedCount() - this.selectedVisible());

  protected readonly allVisibleSelected = computed(
    () => this.visibleItems().length > 0 && this.selectedVisible() === this.visibleItems().length,
  );

  protected readonly canPlan = computed(
    () => this.tool() !== null && this.selectedCount() > 0 && this.phase() === 'select',
  );

  protected readonly toolLocative = computed(() => {
    const tool = this.tool();
    return tool === null ? '' : toolLocative(tool);
  });

  protected readonly planTool = computed(() => {
    const plan = this.plan();
    return plan === null ? '' : toolLabel(plan.tool);
  });

  protected readonly planToolLocative = computed(() => {
    const plan = this.plan();
    return plan === null ? '' : toolLocative(plan.tool);
  });

  protected readonly counts = computed(() => {
    const plan = this.plan();
    return plan === null ? null : countPlan(plan);
  });

  protected readonly decisions = computed<DecisionView[]>(() => {
    const plan = this.plan();
    if (plan === null) return [];
    const open = new Set(plan.conflicts.filter(hasOptions).map(conflictKey));
    const choices = this.choices();
    return [...this.points().values()].map((point) => ({
      ...point,
      chosen: choices.get(point.key) ?? null,
      settled: !open.has(point.key),
    }));
  });

  protected readonly openDecisions = computed(
    () => this.plan()?.conflicts.filter(hasOptions).length ?? 0,
  );

  protected readonly titleMap = computed(
    () => new Map(this.visibleItems().map((item) => [item.id, item.title])),
  );

  protected readonly blockerList = computed(() => {
    const plan = this.plan();
    const counts = this.counts();
    return plan === null || counts === null ? [] : blockers(plan, counts);
  });

  protected readonly sentence = computed(() => {
    switch (this.phase()) {
      case 'select': {
        const state = this.items();
        if (state.status === 'loading') return 'Wczytuję bibliotekę.';
        if (state.status === 'error') return 'Nie udało się wczytać biblioteki.';
        if (state.total === 0 && !this.filtered())
          return 'Biblioteka jest pusta, więc nie ma czego eksportować.';
        return 'Wybierz narzędzie i elementy, które trafią do jego konfiguracji.';
      }
      case 'planning':
        return 'Przygotowuję plan zapisu. Niczego jeszcze nie zapisuję.';
      case 'plan': {
        const plan = this.plan();
        const counts = this.counts();
        if (plan === null || counts === null) return '';
        if (plan.toolMissing) {
          return `Nie ma narzędzia ${this.planTool()} na tym komputerze, więc eksport jest niemożliwy.`;
        }
        if (this.replanning())
          return 'Przeliczam plan po Twojej decyzji. Niczego jeszcze nie zapisuję.';
        if (plan.conflicts.length > 0) {
          return plan.conflicts.every(hasOptions)
            ? 'Plik w narzędziu wymaga Twojej decyzji, zanim zapis będzie możliwy.'
            : 'Plan ma konflikty, więc nie da się go zapisać.';
        }
        if (plan.applicable) {
          const n = counts.changes;
          return `Zapis zmieni ${n} ${plural(n, 'plik', 'pliki', 'plików')} w ${this.planToolLocative()}.`;
        }
        if (counts.blocked > 0)
          return 'Część plików jest zablokowana, więc nie da się zapisać planu.';
        if (plan.entries.length > 0 && counts.changes === 0) {
          return 'Cel jest zgodny z biblioteką, więc zapis nie zmieni żadnego pliku.';
        }
        return 'Z tego wyboru nie powstanie żaden plik.';
      }
      case 'applying':
        return `Zapisuję zmiany w ${this.planToolLocative()}.`;
      case 'result': {
        const r = this.result();
        if (r === null) return '';
        const failed = r.entries.some((e) => e.outcome === 'failed');
        if (r.rolledBack)
          return 'Zapis się nie udał, a aplikacja przywróciła poprzedni stan plików.';
        if (failed)
          return 'Zapis się nie udał, a aplikacja nie przywróciła w pełni poprzedniego stanu.';
        const written = r.entries.filter((e) => e.outcome === 'written').length;
        if (written === 0) return 'Nic nie zostało zapisane.';
        return `Zapisano ${written} ${plural(written, 'plik', 'pliki', 'plików')} w ${this.planToolLocative()}.`;
      }
    }
  });

  protected readonly stepLabel = computed(() => {
    switch (this.phase()) {
      case 'select':
      case 'planning':
        return 'Eksport, krok 1 z 3: wybór';
      case 'plan':
      case 'applying':
        return 'Eksport, krok 2 z 3: plan';
      case 'result':
        return 'Eksport, krok 3 z 3: wynik';
    }
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.debounce);
      this.seq++;
      this.itemsSeq++;
    });

    this.preselect = this.selection.take();

    effect(() => {
      const id = this.itemId();
      if (id !== null && !this.preselect.includes(id)) this.preselect = [...this.preselect, id];
    });

    // Po zmianie kroku fokus idzie na zdanie, zeby czytnik ekranu i klawiatura wiedzialy, ze tresc sie zmienila.
    let first = true;
    effect(() => {
      this.phase();
      if (first) {
        first = false;
        return;
      }
      setTimeout(() => document.getElementById('export-heading')?.focus(), 0);
    });

    void this.loadItems();
  }

  // ---- Krok 1 ----

  protected async loadItems(): Promise<void> {
    const seq = ++this.itemsSeq;
    this.refreshing.set(true);
    const query = this.query().trim();
    const result = await this.libraryApi.list(query === '' ? {} : { query });
    if (seq !== this.itemsSeq) return;
    this.refreshing.set(false);
    if (!result.ok) {
      this.items.set({ status: 'error', message: result.error.message });
      return;
    }
    const items = result.value.items;
    if (!this.firstLoadDone && query === '') {
      this.firstLoadDone = true;
      const known = new Set(items.map((item) => item.id));
      const initial = this.preselect.filter((id) => known.has(id));
      if (initial.length > 0) this.selected.set(new Set(initial));
    }
    this.items.set({ status: 'ready', items, total: items.length });
  }

  protected retryItems(): void {
    this.items.set({ status: 'loading' });
    void this.loadItems();
  }

  protected onQuery(value: string): void {
    this.query.set(value);
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.loadItems(), SEARCH_DEBOUNCE_MS);
  }

  protected clearQuery(): void {
    this.query.set('');
    void this.loadItems();
  }

  protected onTool(value: ToolIdDto): void {
    this.tool.set(value);
  }

  protected toggleItem(id: string, checked: boolean): void {
    const next = new Set(this.selected());
    if (checked) next.add(id);
    else next.delete(id);
    this.selected.set(next);
  }

  protected selectAllVisible(): void {
    const next = new Set(this.selected());
    for (const item of this.visibleItems()) next.add(item.id);
    this.selected.set(next);
  }

  protected clearSelection(): void {
    this.selected.set(new Set());
  }

  protected itemHref(id: string): string {
    return `#${ROUTES.libraryItem(id)}`;
  }

  protected async preparePlan(): Promise<void> {
    const tool = this.tool();
    if (tool === null || this.selectedCount() === 0 || this.phase() !== 'select') return;
    const seq = ++this.seq;
    this.planError.set(null);
    this.phase.set('planning');
    const itemIds = [...this.selected()];
    this.lastRequest = { tool, itemIds };
    this.choices.set(new Map());
    this.points.set(new Map());
    const result = await this.exportApi.plan({ tool, itemIds });
    if (seq !== this.seq) return;
    if (!result.ok) {
      this.planError.set(result.error.message);
      this.phase.set('select');
      return;
    }
    this.rememberDecisions(result.value);
    this.plan.set(result.value);
    this.applyError.set(null);
    this.phase.set('plan');
  }

  protected cancelPlanning(): void {
    this.seq++;
    this.phase.set('select');
  }

  // ---- Krok 2 ----

  /**
   * Wybor opcji konfliktu: ten sam plan zapytania (narzedzie i elementy) z decyzjami dla wszystkich
   * konfliktow, w ktorych cos wybrano. Nowy plan ma nowy `planId`; stary nie jest juz zapisywany.
   */
  protected async decide(
    itemId: string,
    relPath: string,
    resolution: ConflictResolutionDto,
  ): Promise<void> {
    const request = this.lastRequest;
    if (request === null || this.phase() !== 'plan' || this.replanning()) return;
    const key = decisionKey(itemId, relPath);
    const previous = this.choices();
    const next = new Map(previous);
    next.set(key, resolution);
    const seq = ++this.seq;
    this.choices.set(next);
    this.replanError.set(null);
    this.replanning.set(true);
    const resolutions = [...next.entries()].map(([k, value]) => {
      const point = this.points().get(k);
      return { itemId: point?.itemId ?? '', relPath: point?.relPath ?? '', resolution: value };
    });
    const result = await this.exportApi.plan({ ...request, resolutions });
    if (seq !== this.seq) return;
    this.replanning.set(false);
    if (!result.ok) {
      this.choices.set(previous);
      this.replanError.set(result.error.message);
    } else {
      this.rememberDecisions(result.value);
      this.plan.set(result.value);
    }
    setTimeout(() => {
      const group = Array.from(document.querySelectorAll<HTMLElement>('[data-decision-key]')).find(
        (el) => el.dataset['decisionKey'] === key,
      );
      const radio =
        group?.querySelector<HTMLInputElement>('input:checked') ??
        group?.querySelector<HTMLInputElement>('input');
      radio?.focus();
    }, 0);
  }

  /** Zapamietuje konflikty z opcjami i usuwa wybory, ktorych plan juz nie oferuje. */
  private rememberDecisions(plan: ExportPlanDto): void {
    const points = new Map(this.points());
    const choices = new Map(this.choices());
    for (const conflict of plan.conflicts) {
      if (!hasOptions(conflict)) continue;
      const key = conflictKey(conflict);
      const options = conflict.options ?? [];
      points.set(key, {
        key,
        itemId: conflict.itemIds[0] ?? '',
        relPath: conflict.relPath,
        itemIds: conflict.itemIds,
        reason: conflict.reason,
        options,
      });
      const chosen = choices.get(key);
      if (chosen !== undefined && !options.some((o) => o.id === chosen)) choices.delete(key);
    }
    this.points.set(points);
    this.choices.set(choices);
  }

  protected backToSelection(): void {
    this.seq++;
    this.replanning.set(false);
    this.replanError.set(null);
    this.choices.set(new Map());
    this.points.set(new Map());
    this.plan.set(null);
    this.applyError.set(null);
    this.confirming.set(false);
    this.phase.set('select');
  }

  /** Plan jest jednorazowy: po nieudanym zapisie trzeba go przygotowac od nowa z tym samym wyborem. */
  protected replan(): void {
    this.backToSelection();
    void this.preparePlan();
  }

  protected openConfirm(): void {
    const plan = this.plan();
    if (plan === null || !plan.applicable || this.phase() !== 'plan' || this.replanning()) return;
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
    const result = await this.exportApi.apply({ planId: plan.planId, approved: true });
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

  protected restart(): void {
    this.seq++;
    this.replanning.set(false);
    this.replanError.set(null);
    this.choices.set(new Map());
    this.points.set(new Map());
    this.plan.set(null);
    this.result.set(null);
    this.applyError.set(null);
    this.planError.set(null);
    this.selected.set(new Set());
    this.confirming.set(false);
    this.query.set('');
    this.phase.set('select');
    void this.loadItems();
  }

  /** j / k przesuwaja fokus po elementach i wpisach planu (DESIGN.md, Klawiatura). Spacja zaznacza natywnie. */
  protected onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const phase = this.phase();
    if (phase !== 'select' && phase !== 'plan') return;
    if (document.querySelector('dialog[open]') !== null) return;
    const target = event.target;
    if (event.key === '/' && phase === 'select') {
      if (target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
        return;
      event.preventDefault();
      document.getElementById('export-query')?.focus();
      return;
    }
    if (event.key !== 'j' && event.key !== 'k') return;
    if (target instanceof HTMLElement) {
      const isTextEntry =
        target.isContentEditable ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        (target.tagName === 'INPUT' &&
          !['checkbox', 'radio'].includes((target as HTMLInputElement).type));
      if (isTextEntry) return;
    }
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-export-nav]'));
    if (rows.length === 0) return;
    event.preventDefault();
    const current = rows.indexOf(document.activeElement as HTMLElement);
    const step = event.key === 'j' ? 1 : -1;
    const next =
      current === -1
        ? step === 1
          ? 0
          : rows.length - 1
        : Math.min(rows.length - 1, Math.max(0, current + step));
    rows[next]?.focus();
  }
}
