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
 * Jawne potwierdzenie zapisu. Okno liczy to, co sie stanie: pliki do utworzenia, dowiazania
 * i nadpisania. Eksport niczego nie usuwa, wiec okno jest neutralne (pasek w kolorze tekstu),
 * a nadpisanie dostaje sygnal z DESIGN.md. Fokus startuje na "Wróć do planu".
 */
@Component({
  selector: 'app-export-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dialog
      class="dialog"
      aria-labelledby="export-confirm-title"
      data-testid="export-confirm-dialog"
      (cancel)="onCancel($event)"
    >
      <div class="dialog__body">
        <h2 class="dialog__title" id="export-confirm-title" tabindex="-1">
          Zapisać zmiany w {{ toolName() }}?
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
        <p>
          <span class="dialog__label">Kopia zapasowa.</span> Przed zapisem aplikacja zabezpiecza
          kopią każdy plik, który nadpisze. Niczego nie usuwa i nie rusza plików spoza planu. Jeśli
          zapis się nie uda, wycofa zmiany.
        </p>
        <div class="row-actions">
          <button
            type="button"
            class="btn btn--primary"
            data-testid="export-confirm-apply"
            (click)="confirmed.emit()"
          >
            Zapisz zmiany w {{ toolName() }}
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
