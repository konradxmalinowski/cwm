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

import type { CandidateDto } from '../../../../shared/ipc/import-contract';
import { rememberOpener } from '../../core/focus/opener-focus';
import { plural } from '../../core/labels';
import { hitLocation, pathLabel } from './import-model';

/**
 * Zaznaczenie kandydata z sekretem wymaga osobnego potwierdzenia, z powodem kazdego trafienia.
 * Wartosc sekretu nie przychodzi z main, wiec nie ma jej tu jak pokazac. Okno jest neutralne
 * (pasek w kolorze tekstu): import niczego nie usuwa, wiec czerwien nie ma tu zastosowania.
 */
@Component({
  selector: 'app-secret-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dialog
      class="dialog"
      aria-labelledby="secret-title"
      data-testid="secret-dialog"
      (cancel)="onCancel($event)"
    >
      <div class="dialog__body">
        <h2 class="dialog__title" id="secret-title" tabindex="-1">
          Zaznaczyć „{{ candidate().title }}” mimo możliwego sekretu?
        </h2>
        <p>
          <span class="dialog__label">Możliwy sekret.</span> Reguły znalazły {{ count() }}
          {{ hitsNoun() }}. Po zaznaczeniu ten element trafi do biblioteki razem z plikami, w
          których znaleziono trafienia. Aplikacja nie pokazuje wartości, tylko miejsce i powód.
        </p>
        <p class="mono">{{ path() }}</p>
        <ul class="notice__list" data-testid="secret-hits">
          @for (hit of candidate().secrets; track $index) {
            <li>
              {{ hit.reason }}
              <span class="mono">({{ location(hit) }}, reguła {{ hit.rule }})</span>
            </li>
          }
        </ul>
        <div class="row-actions">
          <button type="button" class="btn btn--primary" (click)="confirmed.emit()">
            Zaznacz mimo sekretu
          </button>
          <button type="button" class="btn" autofocus (click)="cancelled.emit()">
            Zostaw odznaczony
          </button>
        </div>
      </div>
    </dialog>
  `,
})
export class SecretConfirmDialogComponent {
  readonly candidate = input.required<CandidateDto>();
  readonly confirmed = output<void>();
  readonly cancelled = output<void>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly location = hitLocation;

  constructor() {
    afterNextRender(() => {
      this.dialog().nativeElement.showModal();
    });
    const restoreFocus = rememberOpener();
    inject(DestroyRef).onDestroy(() => {
      const element = this.dialog().nativeElement;
      if (element.open) element.close();
      restoreFocus();
    });
  }

  protected count(): number {
    return this.candidate().secrets.length;
  }

  protected hitsNoun(): string {
    return plural(this.count(), 'trafienie', 'trafienia', 'trafień');
  }

  protected path(): string {
    return pathLabel(this.candidate());
  }

  protected onCancel(event: Event): void {
    event.preventDefault();
    this.cancelled.emit();
  }
}
