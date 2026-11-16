import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';

import type { ReportPreviewDto } from '../../../../shared/ipc/diagnostics-contract';
import { DiagnosticsApiService } from '../../core/ipc/diagnostics-api.service';
import { rememberOpener } from '../../core/focus/opener-focus';

type DialogState =
  | { readonly status: 'planning' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'preview' | 'saving';
      readonly preview: ReportPreviewDto;
      readonly note: string | null;
      readonly error: string | null;
    }
  | { readonly status: 'saved'; readonly fileName: string };

/**
 * Eksport raportu do zgloszenia bledu (ADR 0053): podglad calej tresci, potem zapis przez
 * systemowe okno. Renderer nie sklada raportu i nie zna sciezki; pokazuje to, co zredagowal
 * main, i prosi main o zapis tego samego podgladu po identyfikatorze.
 */
@Component({
  selector: 'app-report-dialog',
  templateUrl: './report-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReportDialogComponent {
  private readonly api = inject(DiagnosticsApiService);

  readonly closed = output<void>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly state = signal<DialogState>({ status: 'planning' });

  constructor() {
    afterNextRender(() => {
      this.dialog().nativeElement.showModal();
      void this.load();
    });
    // Gdy tresc zastapi komunikat o ladowaniu albo zapisie, fokus idzie na tytul, zeby czytnik
    // ekranu odczytal nowa tresc zamiast zostawic fokus na przycisku, ktory zniknal.
    effect(() => {
      const status = this.state().status;
      if (status === 'planning' || status === 'saving') return;
      setTimeout(() => {
        this.dialog().nativeElement.querySelector<HTMLElement>('#report-title')?.focus();
      }, 0);
    });
    const restoreFocus = rememberOpener();
    inject(DestroyRef).onDestroy(() => {
      const element = this.dialog().nativeElement;
      if (element.open) element.close();
      restoreFocus();
    });
  }

  protected async load(): Promise<void> {
    this.state.set({ status: 'planning' });
    const result = await this.api.reportPreview();
    this.state.set(
      result.ok
        ? { status: 'preview', preview: result.value, note: null, error: null }
        : { status: 'error', message: result.error.message },
    );
  }

  protected async save(): Promise<void> {
    const s = this.state();
    if (s.status !== 'preview') return;
    this.state.set({ ...s, status: 'saving', note: null, error: null });
    const result = await this.api.reportSave(s.preview.previewId);
    if (!result.ok) {
      this.state.set({ ...s, status: 'preview', note: null, error: result.error.message });
      return;
    }
    this.state.set(
      result.value.status === 'saved'
        ? { status: 'saved', fileName: result.value.fileName }
        : {
            ...s,
            status: 'preview',
            note: 'Zapis anulowany. Nic nie zostało zapisane.',
            error: null,
          },
    );
  }

  protected close(): void {
    this.closed.emit();
  }

  /** Escape zamyka natywny dialog; przekazujemy to dalej, zeby rodzic zdjal go z drzewa. */
  protected onCancel(event: Event): void {
    event.preventDefault();
    if (this.state().status !== 'saving') this.close();
  }
}
