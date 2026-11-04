import { ChangeDetectionStrategy, Component, computed, input, linkedSignal } from '@angular/core';

import type { ExportPlanDto, PlanEntryDto } from '../../../../shared/ipc/export-contract';
import { kindLabel, plural } from '../../core/labels';
import { joinRootPath, toolLabel } from '../import/import-model';
import { DiffViewComponent } from './diff-view.component';
import {
  HIDDEN_SECRET_NOTE,
  actionLabel,
  actionMark,
  LEVELS,
  MATERIALIZATION,
  SCOPE_LABEL,
  SEGMENT_SLOTS,
  countPlan,
  diffPair,
  entryKind,
  hasHiddenSecret,
  type EntryKind,
} from './export-model';
import { PlanStatsComponent } from './plan-stats.component';

/**
 * Plan zapisu jednego narzedzia: liczby, zgodnosc, pliki z diffem, odmowy, konflikty i sieroty.
 * Uzywany przez eksport, synchronizacje i cofanie operacji, zeby kazdy zapis wygladal tak samo.
 * Przyciski zatwierdzenia i suma zostaja w widoku, ktory plan wlasnie pokazuje.
 */
@Component({
  selector: 'app-plan-view',
  imports: [DiffViewComponent, PlanStatsComponent],
  templateUrl: './plan-view.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanViewComponent {
  readonly plan = input.required<ExportPlanDto>();
  /** Tytuly elementow spoza planu (np. z biblioteki); plan zna tylko te, ktore ma w zgodnosci. */
  readonly titles = input<ReadonlyMap<string, string>>(new Map());
  /** Poziom naglowkow sekcji: 2 w eksporcie, 3 gdy plan jest czescia wiekszego widoku. */
  readonly level = input<2 | 3>(2);
  readonly showStats = input(true);

  protected readonly levels = LEVELS;
  protected readonly segmentSlots = SEGMENT_SLOTS;
  protected readonly actionLabel = actionLabel;
  protected readonly actionMark = actionMark;
  protected readonly secretNote = HIDDEN_SECRET_NOTE;
  protected readonly hasHiddenSecret = hasHiddenSecret;
  protected readonly scopeLabel = SCOPE_LABEL;
  protected readonly materialization = MATERIALIZATION;
  protected readonly kindLabel = kindLabel;
  protected readonly plural = plural;

  protected readonly counts = computed(() => countPlan(this.plan()));
  protected readonly tool = computed(() => toolLabel(this.plan().tool));
  protected readonly prefix = computed(() => `plan-${this.plan().planId}`);

  /** Wpisy nadpisujace z podgladem sa od razu rozwiniete: uzytkownik ma zobaczyc, co zniknie. */
  protected readonly openEntries = linkedSignal<ReadonlySet<string>>(
    () =>
      new Set(
        this.plan()
          .entries.filter((e) => {
            const kind = entryKind(e);
            return (
              (kind === 'modify' && e.before !== null && e.after !== null) || kind === 'delete'
            );
          })
          .slice(0, 5)
          .map((e) => e.entryId),
      ),
  );

  private readonly titlesById = computed(() => {
    const map = new Map<string, string>(this.titles());
    const plan = this.plan();
    for (const verdict of plan.verdicts) map.set(verdict.itemId, verdict.title);
    for (const refusal of plan.refusals) {
      if (!map.has(refusal.itemId)) map.set(refusal.itemId, refusal.slug);
    }
    return map;
  });

  protected kindOf(entry: PlanEntryDto): EntryKind {
    return entryKind(entry);
  }

  protected titleOf(itemId: string): string {
    return this.titlesById().get(itemId) ?? 'Element spoza planu';
  }

  protected titlesOf(itemIds: readonly string[]): string {
    return itemIds.map((id) => this.titleOf(id)).join(', ');
  }

  protected pathOf(entry: { rootLabel: string; relPath: string }): string {
    return joinRootPath(entry.rootLabel, entry.relPath);
  }

  protected hasDiff(entry: PlanEntryDto): boolean {
    const kind = entryKind(entry);
    return kind !== 'link' && kind !== 'restore-link' && kind !== 'unchanged';
  }

  protected diffPair = diffPair;

  protected isOpen(entryId: string): boolean {
    return this.openEntries().has(entryId);
  }

  protected onToggle(entryId: string, event: Event): void {
    const open = (event.target as HTMLDetailsElement).open;
    const next = new Set(this.openEntries());
    if (open) next.add(entryId);
    else next.delete(entryId);
    this.openEntries.set(next);
  }
}
