import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';

import type { ExportApplyDto, ExportPlanDto } from '../../../../shared/ipc/export-contract';
import type { HistoryEntryDto } from '../../../../shared/ipc/sync-contract';
import { ExportApiService } from '../../core/ipc/export-api.service';
import { HistoryApiService } from '../../core/ipc/history-api.service';
import { LibraryApiService } from '../../core/ipc/library-api.service';
import { formatDate, plural } from '../../core/labels';
import { ROUTES } from '../../core/routing/route';
import { ApplyResultComponent } from '../export/apply-result.component';
import { ExportConfirmDialogComponent } from '../export/export-confirm-dialog.component';
import { blockers, countPlan } from '../export/export-model';
import { PlanViewComponent } from '../export/plan-view.component';
import { toolLabel } from '../import/import-model';
import { PAGE_SIZE, historyKindLabel, nextCursor, undoLabel } from './history-model';

type ListState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready' };

type Phase = 'list' | 'planning' | 'plan' | 'applying' | 'result';

@Component({
  selector: 'app-history',
  imports: [ApplyResultComponent, ExportConfirmDialogComponent, PlanViewComponent],
  templateUrl: './history.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HistoryComponent {
  private readonly historyApi = inject(HistoryApiService);
  private readonly exportApi = inject(ExportApiService);
  private readonly libraryApi = inject(LibraryApiService);

  protected readonly syncHref = `#${ROUTES.sync}`;
  protected readonly kindLabel = historyKindLabel;
  protected readonly undoLabel = undoLabel;
  protected readonly toolLabel = toolLabel;
  protected readonly formatDate = formatDate;
  protected readonly plural = plural;

  protected readonly phase = signal<Phase>('list');
  protected readonly listState = signal<ListState>({ status: 'loading' });
  protected readonly entries = signal<readonly HistoryEntryDto[]>([]);
  protected readonly hasMore = signal(false);
  protected readonly loadingMore = signal(false);
  protected readonly moreError = signal<string | null>(null);
  protected readonly titles = signal<ReadonlyMap<string, string>>(new Map());

  protected readonly target = signal<HistoryEntryDto | null>(null);
  protected readonly plan = signal<ExportPlanDto | null>(null);
  protected readonly planError = signal<string | null>(null);
  protected readonly applyError = signal<string | null>(null);
  protected readonly result = signal<ExportApplyDto | null>(null);
  protected readonly confirming = signal(false);

  private seq = 0;
  private listSeq = 0;

  private readonly byId = computed(
    () => new Map(this.entries().map((entry) => [entry.operationId, entry])),
  );

  protected readonly counts = computed(() => {
    const plan = this.plan();
    return plan === null ? null : countPlan(plan);
  });

  protected readonly blockerList = computed(() => {
    const plan = this.plan();
    const counts = this.counts();
    return plan === null || counts === null ? [] : blockers(plan, counts);
  });

  protected readonly planTool = computed(() => {
    const plan = this.plan();
    return plan === null ? '' : toolLabel(plan.tool);
  });

  protected readonly sentence = computed(() => {
    switch (this.phase()) {
      case 'list': {
        const state = this.listState();
        if (state.status === 'loading') return 'Wczytuję historię operacji.';
        if (state.status === 'error') return 'Nie udało się wczytać historii.';
        const n = this.entries().length;
        if (n === 0) return 'Historia jest pusta, bo aplikacja jeszcze niczego nie zapisała.';
        const more = this.hasMore() ? ' Starsze wpisy możesz dołączyć na końcu listy.' : '';
        return `Pokazuję ${n} ${plural(n, 'ostatnią operację', 'ostatnie operacje', 'ostatnich operacji')}.${more}`;
      }
      case 'planning':
        return 'Przygotowuję plan cofnięcia. Niczego jeszcze nie zapisuję.';
      case 'plan': {
        const plan = this.plan();
        const counts = this.counts();
        if (plan === null || counts === null) return '';
        if (plan.toolMissing)
          return `Nie ma narzędzia ${this.planTool()} na tym komputerze, więc cofnięcie jest niemożliwe.`;
        if (!plan.applicable) {
          if (counts.blocked > 0)
            return 'Część plików jest zablokowana, więc nie da się cofnąć operacji.';
          if (counts.changes === 0) return 'Pliki są już w stanie sprzed tej operacji.';
          return 'Tej operacji nie da się teraz cofnąć.';
        }
        const n = counts.changes;
        if (counts.remove > 0)
          return `Cofnięcie zmieni ${n} ${plural(n, 'plik', 'pliki', 'plików')}, w tym usunie ${counts.remove} z dysku.`;
        return `Cofnięcie zmieni ${n} ${plural(n, 'plik', 'pliki', 'plików')} w ${this.planTool()}.`;
      }
      case 'applying':
        return 'Cofam operację. Nie zamykaj aplikacji, dopóki zapis się nie skończy.';
      case 'result': {
        const r = this.result();
        if (r === null) return '';
        if (r.rolledBack)
          return 'Cofnięcie się nie udało, a aplikacja przywróciła stan plików sprzed próby.';
        if (r.entries.some((e) => e.outcome === 'failed'))
          return 'Cofnięcie się nie udało, a aplikacja nie przywróciła w pełni poprzedniego stanu.';
        const written = r.entries.filter((e) => e.outcome === 'written').length;
        if (written === 0) return 'Nic nie zostało zmienione.';
        return `Cofnięto operację: zmieniono ${written} ${plural(written, 'plik', 'pliki', 'plików')}.`;
      }
    }
  });

  protected readonly stepLabel = computed(() => {
    switch (this.phase()) {
      case 'list':
        return '6. Historia';
      case 'planning':
      case 'plan':
      case 'applying':
        return '6. Historia, cofnięcie, krok 1 z 2: plan';
      case 'result':
        return '6. Historia, cofnięcie, krok 2 z 2: wynik';
    }
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.seq++;
      this.listSeq++;
    });

    let first = true;
    effect(() => {
      this.phase();
      if (first) {
        first = false;
        return;
      }
      setTimeout(() => document.getElementById('history-heading')?.focus(), 0);
    });

    void this.load();
    void this.loadTitles();
  }

  // ---- Lista ----

  protected async load(): Promise<void> {
    const seq = ++this.listSeq;
    const result = await this.historyApi.list({ limit: PAGE_SIZE });
    if (seq !== this.listSeq) return;
    if (!result.ok) {
      this.listState.set({ status: 'error', message: result.error.message });
      return;
    }
    this.entries.set(result.value.entries);
    this.hasMore.set(result.value.entries.length >= PAGE_SIZE);
    this.listState.set({ status: 'ready' });
  }

  protected retry(): void {
    this.listState.set({ status: 'loading' });
    void this.load();
  }

  protected async loadMore(): Promise<void> {
    const cursor = nextCursor(this.entries());
    if (cursor === null || this.loadingMore()) return;
    const seq = ++this.listSeq;
    this.loadingMore.set(true);
    this.moreError.set(null);
    const result = await this.historyApi.list({ limit: PAGE_SIZE, before: cursor });
    if (seq !== this.listSeq) return;
    this.loadingMore.set(false);
    if (!result.ok) {
      this.moreError.set(result.error.message);
      return;
    }
    const known = new Set(this.entries().map((e) => e.operationId));
    const fresh = result.value.entries.filter((e) => !known.has(e.operationId));
    this.entries.set([...this.entries(), ...fresh]);
    this.hasMore.set(result.value.entries.length >= PAGE_SIZE && fresh.length > 0);
  }

  /** Tytuly do linkow. Gdy biblioteka sie nie wczyta, linki dostaja neutralny opis. */
  private async loadTitles(): Promise<void> {
    const result = await this.libraryApi.list({});
    if (!result.ok) return;
    this.titles.set(new Map(result.value.items.map((item) => [item.id, item.title])));
  }

  protected itemTitle(id: string): string {
    return this.titles().get(id) ?? 'Element usunięty z biblioteki';
  }

  protected itemKnown(id: string): boolean {
    return this.titles().has(id);
  }

  protected itemHref(id: string): string {
    return `#${ROUTES.libraryItem(id)}`;
  }

  protected revertedByText(id: string): string {
    const entry = this.byId().get(id);
    return entry === undefined
      ? 'Cofnięta późniejszą operacją.'
      : `Cofnięta przez: ${this.kindLabel(entry.kind).toLowerCase()} z ${formatDate(entry.at)}.`;
  }

  // ---- Cofanie ----

  protected async startRollback(entry: HistoryEntryDto): Promise<void> {
    if (this.phase() !== 'list') return;
    const seq = ++this.seq;
    this.target.set(entry);
    this.planError.set(null);
    this.phase.set('planning');
    const result = await this.historyApi.rollback({ operationId: entry.operationId });
    if (seq !== this.seq) return;
    if (!result.ok) {
      this.planError.set(result.error.message);
      this.target.set(null);
      this.phase.set('list');
      return;
    }
    this.plan.set(result.value);
    this.applyError.set(null);
    this.phase.set('plan');
  }

  protected cancelPlanning(): void {
    this.seq++;
    this.target.set(null);
    this.phase.set('list');
  }

  protected backToList(): void {
    this.seq++;
    this.plan.set(null);
    this.target.set(null);
    this.applyError.set(null);
    this.confirming.set(false);
    this.phase.set('list');
    setTimeout(() => document.getElementById('history-heading')?.focus(), 0);
  }

  /** Plan jest jednorazowy: po nieudanym zapisie trzeba go przygotowac od nowa. */
  protected replan(): void {
    const entry = this.target();
    this.backToList();
    if (entry !== null) void this.startRollback(entry);
  }

  protected openConfirm(): void {
    const plan = this.plan();
    if (plan === null || !plan.applicable || this.phase() !== 'plan') return;
    this.confirming.set(true);
  }

  protected cancelConfirm(): void {
    this.confirming.set(false);
    setTimeout(
      () => document.querySelector<HTMLElement>('[data-testid="history-apply"]')?.focus(),
      0,
    );
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

  protected finish(): void {
    this.seq++;
    this.plan.set(null);
    this.result.set(null);
    this.target.set(null);
    this.confirming.set(false);
    this.listState.set({ status: 'loading' });
    this.phase.set('list');
    void this.load();
  }
}
