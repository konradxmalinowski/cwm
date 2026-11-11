import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  linkedSignal,
  output,
} from '@angular/core';

import type {
  ConflictResolutionDto,
  ExportPlanDto,
  PlanEntryDto,
} from '../../../../shared/ipc/export-contract';
import { kindLabel, plural } from '../../core/labels';
import { joinRootPath, toolLabel } from '../import/import-model';
import { DiffViewComponent } from './diff-view.component';
import {
  HIDDEN_SECRET_NOTE,
  actionLabel,
  actionMark,
  LEVELS,
  MATERIALIZATION,
  OPTION_HINT,
  SCOPE_LABEL,
  SEGMENT_SLOTS,
  conflictKey,
  countPlan,
  diffPair,
  entryKind,
  hasHiddenSecret,
  otherWarnings,
  overwriteInfo,
  type DecisionView,
  type EntryKind,
  type OverwriteInfo,
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
  /**
   * Konflikty z decyzja do podjecia. Pusta lista: widok jest tylko do czytania (synchronizacja,
   * cofanie), a konflikt zostaje informacja bez kontrolki.
   */
  readonly decisions = input<readonly DecisionView[]>([]);
  /** Wybor zapisany w widoku nadrzednym, ktory przelicza plan: `chosen` w `DecisionView`. */
  readonly decide = output<{
    itemId: string;
    relPath: string;
    resolution: ConflictResolutionDto;
  }>();

  protected readonly levels = LEVELS;
  protected readonly segmentSlots = SEGMENT_SLOTS;
  protected readonly actionLabel = actionLabel;
  protected readonly actionMark = actionMark;
  protected readonly secretNote = HIDDEN_SECRET_NOTE;
  protected readonly hasHiddenSecret = hasHiddenSecret;
  protected readonly scopeLabel = SCOPE_LABEL;
  protected readonly materialization = MATERIALIZATION;
  protected readonly optionHint = OPTION_HINT;
  protected readonly otherWarnings = otherWarnings;
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

  /** Konflikty, dla ktorych widok nie ma grupy decyzji: informacja bez kontrolki. */
  protected readonly plainConflicts = computed(() => {
    const keys = new Set(this.decisions().map((d) => d.key));
    return this.plan().conflicts.filter((k) => !keys.has(conflictKey(k)));
  });

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

  protected overwriteOf(entry: PlanEntryDto): OverwriteInfo | null {
    return overwriteInfo(entry);
  }

  protected choose(d: DecisionView, resolution: ConflictResolutionDto): void {
    this.decide.emit({ itemId: d.itemId, relPath: d.relPath, resolution });
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
