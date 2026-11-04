import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';

import { plural } from '../../core/labels';
import type { PlanCounts } from './export-model';

/**
 * Jawne potwierdzenie zapisu. Okno liczy to, co sie stanie: pliki do utworzenia, dowiazania,
 * nadpisania i usuniecia. Bez usuniec jest neutralne (pasek w kolorze tekstu), nadpisanie
 * dostaje sygnal z DESIGN.md, usuniecie czerwien. Fokus startuje na "Wróć do planu".
 * Ten sam komponent potwierdza eksport, synchronizacje i cofniecie operacji.
 */
@Component({
  selector: 'app-export-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dialog
      class="dialog"
      [class.dialog--destructive]="counts().remove > 0"
      aria-labelledby="export-confirm-title"
      data-testid="export-confirm-dialog"
      (cancel)="onCancel($event)"
    >
      <div class="dialog__body">
        <h2 class="dialog__title" id="export-confirm-title" tabindex="-1">
          {{ title() || 'Zapisać zmiany w ' + toolName() + '?' }}
        </h2>
        <ul class="confirm-facts" data-testid="export-confirm-counts">
          <li>
            <span class="confirm-facts__num">{{ counts().create }}</span>
            {{
              plural(
                counts().create,
                'plik do utworzenia',
                'pliki do utworzenia',
                'plików do utworzenia'
              )
            }}
          </li>
          @if (counts().link > 0) {
            <li>
              <span class="confirm-facts__num">{{ counts().link }}</span>
              {{
                plural(
                  counts().link,
                  'dowiązanie do utworzenia',
                  'dowiązania do utworzenia',
                  'dowiązań do utworzenia'
                )
              }}
            </li>
          }
          <li>
            <span class="confirm-facts__num">{{ counts().modify }}</span>
            {{
              plural(
                counts().modify,
                'plik do nadpisania',
                'pliki do nadpisania',
                'plików do nadpisania'
              )
            }}
          </li>
          @if (counts().remove > 0) {
            <li class="confirm-facts__remove">
              <span class="confirm-facts__num">{{ counts().remove }}</span>
              {{
                plural(
                  counts().remove,
                  'plik do usunięcia z dysku',
                  'pliki do usunięcia z dysku',
                  'plików do usunięcia z dysku'
                )
              }}
            </li>
          }
          @if (adoptions() > 0) {
            <li>
              <span class="confirm-facts__num">{{ adoptions() }}</span>
              {{
                plural(
                  adoptions(),
                  'zmiana z narzędzia do biblioteki',
                  'zmiany z narzędzi do biblioteki',
                  'zmian z narzędzi do biblioteki'
                )
              }}
            </li>
          }
        </ul>
        @if (counts().modify > 0) {
          <p class="signal-overwrite" data-testid="export-confirm-overwrite">
            <span
              ><strong>Nadpisze</strong> {{ counts().modify }}
              {{
                plural(
                  counts().modify,
                  'istniejący plik',
                  'istniejące pliki',
                  'istniejących plików'
                )
              }}
              w {{ toolName() }}.</span
            >
            <span>Poprzednia treść trafi najpierw do kopii zapasowej.</span>
          </p>
        }
        @if (counts().remove > 0) {
          <p class="signal-remove" data-testid="export-confirm-remove">
            <span
              ><strong>Usunie</strong> {{ counts().remove }}
              {{ plural(counts().remove, 'plik', 'pliki', 'plików') }} z dysku.</span
            >
            <span>
              Poprzednia treść trafi najpierw do kopii zapasowej. Odzyskasz ją osobnym krokiem w
              Historii.
            </span>
          </p>
        }
        <p>
          <span class="dialog__label">Kopia zapasowa.</span>
          @if (counts().remove > 0) {
            Przed zapisem aplikacja zabezpiecza kopią każdy plik, który nadpisze albo usunie. Nie
            rusza plików spoza planu. Jeśli zapis się nie uda, wycofa zmiany.
          } @else {
            Przed zapisem aplikacja zabezpiecza kopią każdy plik, który nadpisze. Niczego nie usuwa
            i nie rusza plików spoza planu. Jeśli zapis się nie uda, wycofa zmiany.
          }
        </p>
        <div class="row-actions">
          <button
            type="button"
            class="btn"
            [class.btn--primary]="counts().remove === 0"
            [class.btn--destructive]="counts().remove > 0"
            data-testid="export-confirm-apply"
            (click)="confirmed.emit()"
          >
            {{ confirmLabel() || 'Zapisz zmiany w ' + toolName() }}
          </button>
          <button type="button" class="btn" autofocus (click)="cancelled.emit()">
            Wróć do planu
          </button>
        </div>
      </div>
    </dialog>
  `,
})
export class ExportConfirmDialogComponent {
  readonly toolName = input.required<string>();
  readonly counts = input.required<PlanCounts>();
  /** Zmiany z narzedzi, ktore przebieg przyjmie do biblioteki (tylko synchronizacja). */
  readonly adoptions = input(0);
  readonly title = input('');
  readonly confirmLabel = input('');
  readonly confirmed = output<void>();
  readonly cancelled = output<void>();

  protected readonly plural = plural;

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    afterNextRender(() => {
      this.dialog().nativeElement.showModal();
    });
    inject(DestroyRef).onDestroy(() => {
      const element = this.dialog().nativeElement;
      if (element.open) element.close();
    });
  }

  protected onCancel(event: Event): void {
    event.preventDefault();
    this.cancelled.emit();
  }
}
