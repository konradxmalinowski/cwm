import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { plural } from '../../core/labels';
import { diffLines } from './export-model';

/**
 * Diff liniowy z DESIGN.md (ryzyko 1): tla wierszy neutralne, usuniecia przekreslone i wyciszone,
 * dodania podkreslone akcentem, zmiana w marginesie jako znak. Tresc idzie wylacznie przez
 * interpolacje (tekst), nigdy jako HTML.
 */
@Component({
  selector: 'app-diff-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let d = diff();
    <div class="diff" data-testid="diff">
      <p class="diff__head">
        <span
          >Dodano <strong>{{ d.added }}</strong
          >, usunięto <strong>{{ d.removed }}</strong>
          {{ plural(d.removed, 'wiersz', 'wiersze', 'wierszy') }} w pliku.</span
        >
        <span class="diff__legend" aria-hidden="true">
          <span><span class="diff__mark">+</span> dodane</span>
          <span><span class="diff__mark">&minus;</span> usunięte</span>
        </span>
      </p>
      @if (d.coarse) {
        <p class="diff__note">
          Plik jest za duży, żeby dopasować wiersze. Poniżej cała stara treść, a po niej cała nowa.
        </p>
      }
      @if (d.added === 0 && d.removed === 0) {
        <p class="diff__note">Treść przed i po jest identyczna.</p>
      } @else {
        <div class="diff__body" tabindex="0" role="region" [attr.aria-label]="label()">
          @for (row of d.rows; track $index) {
            @if (row.kind === 'gap') {
              <div class="dl dl--gap">
                <span class="dl__no" aria-hidden="true"></span>
                <span class="dl__no" aria-hidden="true"></span>
                <span class="dl__mk" aria-hidden="true">&middot;</span>
                <span class="dl__tx"
                  >{{ row.hidden }}
                  {{
                    plural(
                      row.hidden,
                      'niezmieniony wiersz',
                      'niezmienione wiersze',
                      'niezmienionych wierszy'
                    )
                  }}
                  pominięto</span
                >
              </div>
            } @else {
              <div
                class="dl"
                [class.dl--add]="row.kind === 'add'"
                [class.dl--del]="row.kind === 'del'"
              >
                <span class="dl__no" aria-hidden="true">{{ row.oldNo }}</span>
                <span class="dl__no" aria-hidden="true">{{ row.newNo }}</span>
                <span class="dl__mk">
                  @if (row.kind === 'add') {
                    <span aria-hidden="true">+</span>
                    <span class="sr-only">Dodano: </span>
                  } @else if (row.kind === 'del') {
                    <span aria-hidden="true">−</span>
                    <span class="sr-only">Usunięto: </span>
                  }
                </span>
                <span class="dl__tx">{{ row.text }}</span>
              </div>
            }
          }
          @if (d.truncated > 0) {
            <p class="diff__note">
              Pokazano pierwsze wiersze. Pominięto jeszcze {{ d.truncated }}
              {{ plural(d.truncated, 'pozycję', 'pozycje', 'pozycji') }} diffu.
            </p>
          }
        </div>
      }
    </div>
  `,
})
export class DiffViewComponent {
  readonly before = input.required<string>();
  readonly after = input.required<string>();
  readonly path = input<string>('');

  protected readonly plural = plural;

  protected readonly diff = computed(() => diffLines(this.before(), this.after()));
  protected readonly label = computed(() =>
    this.path() === '' ? 'Zmiany w pliku' : `Zmiany w pliku ${this.path()}`,
  );
}
