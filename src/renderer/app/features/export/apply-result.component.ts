import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { ExportApplyDto, ExportPlanDto } from '../../../../shared/ipc/export-contract';
import { joinRootPath } from '../import/import-model';
import { OUTCOME_LABEL } from './export-model';

/**
 * Raport z zapisu jednego planu: wycofanie, blad bez wycofania, weryfikacja, wpisy i numer
 * kopii. Wspolny dla eksportu, synchronizacji i cofania operacji.
 */
@Component({
  selector: 'app-apply-result',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let r = result();
    <div class="report" data-testid="export-result">
      @if (r.rolledBack) {
        <div class="notice" role="alert" data-testid="export-rolled-back">
          <p class="notice__text">
            <span class="notice__label">Błąd.</span> Zapis nie przeszedł do końca. Aplikacja
            wycofała zmiany i przywróciła pliki do stanu sprzed zapisu.
          </p>
          <p class="notice__text">
            Błąd jest odwracalny: nic nie zostało po drodze. Możesz przygotować plan od nowa.
          </p>
        </div>
      } @else if (unrestored()) {
        <div class="notice notice--destructive" role="alert" data-testid="export-not-restored">
          <p class="notice__text">
            <span class="notice__label notice__label--destructive">Błąd.</span> Aplikacja nie
            przywróciła w pełni poprzedniego stanu plików. Część plików mogła zostać zmieniona.
          </p>
          <p class="notice__text">
            Poprzednią treść zabezpieczono w kopii zapasowej. Przywrócenie wymaga osobnego kroku z
            Twojej strony.
          </p>
        </div>
      }

      <p class="verify" data-testid="export-verified">
        <span class="notice__label">Weryfikacja.</span>
        @if (r.verified) {
          Aplikacja przeczytała zapisane pliki jeszcze raz i zgadzają się z planem.
        } @else {
          Aplikacja nie potwierdziła, że pliki na dysku zgadzają się z planem. Sprawdź je ręcznie.
        }
      </p>

      <section class="section" [attr.aria-labelledby]="headingId()">
        <p class="section__title" role="heading" [attr.aria-level]="level()" [id]="headingId()">
          {{ title() }}
          <span class="group__count">{{ r.entries.length }}</span>
        </p>
        <ul class="results">
          @for (entry of r.entries; track entry.entryId) {
            <li
              class="results__row"
              data-testid="export-result-entry"
              [attr.data-outcome]="entry.outcome"
            >
              <span class="results__word">{{ outcomeLabel[entry.outcome] }}</span>
              <span class="mono">{{ entryPath(entry.entryId) }}</span>
              @if (entry.message !== null) {
                <span class="view__sub">{{ entry.message }}</span>
              }
            </li>
          }
        </ul>
      </section>

      <p class="view__sub" data-testid="export-backup">
        Identyfikator kopii zapasowej: <span class="mono">{{ r.backupId }}</span>
      </p>
    </div>
  `,
})
export class ApplyResultComponent {
  readonly result = input.required<ExportApplyDto>();
  readonly plan = input<ExportPlanDto | null>(null);
  readonly title = input('Wpisy');
  readonly level = input<2 | 3>(2);

  protected readonly outcomeLabel = OUTCOME_LABEL;

  protected readonly headingId = computed(() => `result-${this.result().planId}`);

  /** Wynik w trybie "blad bez wycofania": aplikacja zostawila czesciowy stan. */
  protected readonly unrestored = computed(() => {
    const r = this.result();
    return !r.rolledBack && r.entries.some((e) => e.outcome === 'failed');
  });

  private readonly entriesById = computed(
    () => new Map((this.plan()?.entries ?? []).map((entry) => [entry.entryId, entry])),
  );

  protected entryPath(entryId: string): string {
    const entry = this.entriesById().get(entryId);
    return entry === undefined ? 'Plik spoza planu' : joinRootPath(entry.rootLabel, entry.relPath);
  }
}
