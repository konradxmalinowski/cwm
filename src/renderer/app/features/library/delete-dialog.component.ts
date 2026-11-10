import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import type { DeletePlanDto } from '../../../../shared/ipc/library-contract';
import { LibraryApiService } from '../../core/ipc/library-api.service';
import { kindLabel, plural } from '../../core/labels';
import { rememberOpener } from '../../core/focus/opener-focus';
import { FlashService } from '../../core/state/flash.service';

type DialogState =
  | { readonly status: 'planning' }
  | { readonly status: 'plan'; readonly plan: DeletePlanDto }
  | { readonly status: 'applying'; readonly plan: DeletePlanDto }
  | { readonly status: 'error'; readonly message: string; readonly plan: DeletePlanDto | null };

/**
 * Usuniecie to dwa kroki: plan, potem potwierdzenie planu (ADR 0031). Kolor zalezy od tego,
 * co plan mowi, a nie od tego, ze to usuwanie: `recoverable` ma kopie, wiec nie jest czerwone;
 * `partial` niszczy pliki bez kopii i dopiero ono jest; `blocked` jest neutralne.
 */
@Component({
  selector: 'app-delete-dialog',
  templateUrl: './delete-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeleteDialogComponent {
  private readonly api = inject(LibraryApiService);
  private readonly flash = inject(FlashService);

  readonly itemId = input.required<string>();
  /** Po usunieciu rodzic zmienia widok, wiec komunikat ma przetrwac to przejscie. */
  readonly navigatesAfter = input(false);
  /** `true`, gdy element zostal usuniety. */
  readonly closed = output<boolean>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly state = signal<DialogState>({ status: 'planning' });
  protected readonly acknowledged = signal(false);
  protected readonly kindLabel = kindLabel;

  protected readonly plan = computed(() => {
    const s = this.state();
    return s.status === 'planning' ? null : s.plan;
  });

  protected readonly displayName = computed(() => {
    const plan = this.plan();
    if (plan === null) return 'ten element';
    return `„${plan.title ?? plan.slug ?? plan.itemId}”`;
  });

  /** Plan ma tytul, ktory mowi, ile plikow przepadnie; liczba i odmiana zgadzaja sie z lista. */
  protected readonly lossSentence = computed(() => {
    const plan = this.plan();
    const n = plan?.unrecoverable.length ?? 0;
    const noun = plural(n, 'plik, którego', 'pliki, których', 'plików, których');
    return `zniszczy ${n} ${noun} nie da się odtworzyć`;
  });

  /** Po bledzie z planem (np. przerwane polaczenie) mozna ponowic ten sam plan. */
  protected readonly canConfirm = computed(() => {
    const s = this.state();
    if (s.status === 'planning' || s.status === 'applying') return false;
    if (s.plan === null) return false;
    return s.plan.recoverability === 'recoverable' || this.acknowledged();
  });

  constructor() {
    afterNextRender(() => {
      const element = this.dialog().nativeElement;
      element.showModal();
      void this.buildPlan();
    });
    // Gdy plan zastapi komunikat o przygotowaniu, fokus wraca do tytulu, zeby czytnik
    // ekranu odczytal nowa tresc zamiast zostawic fokus na usunietym przycisku.
    effect(() => {
      const status = this.state().status;
      if (status === 'planning' || status === 'applying') return;
      setTimeout(() => {
        this.dialog().nativeElement.querySelector<HTMLElement>('#delete-title')?.focus();
      }, 0);
    });
    const restoreFocus = rememberOpener();
    inject(DestroyRef).onDestroy(() => {
      const element = this.dialog().nativeElement;
      if (element.open) element.close();
      restoreFocus();
    });
  }

  protected async buildPlan(): Promise<void> {
    this.state.set({ status: 'planning' });
    this.acknowledged.set(false);
    const result = await this.api.deletePlan({ id: this.itemId() });
    this.state.set(
      result.ok
        ? { status: 'plan', plan: result.value }
        : { status: 'error', message: result.error.message, plan: null },
    );
  }

  protected async confirm(): Promise<void> {
    const s = this.state();
    if (s.status === 'planning' || s.status === 'applying' || s.plan === null) return;
    if (!this.canConfirm()) return;
    const plan = s.plan;
    this.state.set({ status: 'applying', plan });
    const result = await this.api.deleteApply({
      token: plan.token,
      ...(plan.recoverability === 'partial' ? { acknowledgeUnrecoverable: true } : {}),
    });
    if (!result.ok) {
      this.state.set({ status: 'error', message: result.error.message, plan });
      return;
    }
    const name = plan.title ?? plan.slug ?? 'Element';
    this.flash.show(`Usunięto element „${name}”.`, result.value.warnings, this.navigatesAfter());
    this.closed.emit(true);
  }

  protected close(): void {
    this.closed.emit(false);
  }

  /** Escape zamyka natywny dialog; przekazujemy to dalej, zeby rodzic zdjal go z drzewa. */
  protected onCancel(event: Event): void {
    event.preventDefault();
    if (this.state().status !== 'applying') this.close();
  }

  protected onAcknowledge(checked: boolean): void {
    this.acknowledged.set(checked);
  }
}
