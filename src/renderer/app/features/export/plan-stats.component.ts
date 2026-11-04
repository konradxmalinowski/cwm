import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import type { PlanCounts } from './export-model';

/**
 * Liczby planu: najwieksze elementy ekranu (DESIGN.md, ryzyko 2). Zero jest wyciszone,
 * nadpisanie w cobalt-200, usuniecie czerwone, ale tylko gdy jest wieksze od zera. Liczba
 * usuniec pojawia sie wtedy, gdy plan cokolwiek usuwa: eksport nigdy tego nie robi.
 */
@Component({
  selector: 'app-plan-stats',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let c = counts();
    <div class="stats" data-testid="export-stats">
      <p class="stat" [class.stat--zero]="c.create === 0">
        <span class="stat__num">{{ c.create }}</span>
        <span class="stat__label">Utworzy</span>
      </p>
      <p class="stat" [class.stat--zero]="c.modify === 0" [class.stat--overwrite]="c.modify > 0">
        <span class="stat__num">{{ c.modify }}</span>
        <span class="stat__label">Nadpisze</span>
      </p>
      <p class="stat" [class.stat--zero]="c.link === 0">
        <span class="stat__num">{{ c.link }}</span>
        <span class="stat__label">Dowiąże</span>
      </p>
      @if (c.remove > 0) {
        <p class="stat stat--remove" data-testid="plan-stat-remove">
          <span class="stat__num">{{ c.remove }}</span>
          <span class="stat__label">Usunie</span>
        </p>
      }
      <p class="stat" [class.stat--zero]="c.unchanged === 0">
        <span class="stat__num">{{ c.unchanged }}</span>
        <span class="stat__label">Bez zmian</span>
      </p>
      <ng-content />
    </div>
  `,
})
export class PlanStatsComponent {
  readonly counts = input.required<PlanCounts>();
}
