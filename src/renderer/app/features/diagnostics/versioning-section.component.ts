import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  type OnInit,
} from '@angular/core';

import type { VersioningStateDto } from '../../../../shared/ipc/versioning-contract';
import { VersioningApiService } from '../../core/ipc/versioning-api.service';
import { formatDate } from '../../core/labels';

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready' }
  | { readonly status: 'error'; readonly message: string };

type SaveState =
  | { readonly status: 'idle' }
  | { readonly status: 'saving' }
  | { readonly status: 'saved' }
  | { readonly status: 'error'; readonly message: string };

/**
 * Sekcja Diagnostyki: opcjonalne wersjonowanie biblioteki w lokalnym Git (ADR 0060). Dwa pola
 * wyboru i jeden przycisk zapisu, zawsze aktywny: brak potwierdzenia zgody na elementy prywatne
 * daje blad przy polu i fokus na nim, tak jak w kreatorze importu z Git.
 */
@Component({
  selector: 'app-versioning-section',
  templateUrl: './versioning-section.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VersioningSectionComponent implements OnInit {
  private readonly api = inject(VersioningApiService);

  protected readonly formatDate = formatDate;

  protected readonly load = signal<LoadState>({ status: 'loading' });
  protected readonly save = signal<SaveState>({ status: 'idle' });
  protected readonly state = signal<VersioningStateDto | null>(null);
  protected readonly enabled = signal(false);
  protected readonly includePrivate = signal(false);
  protected readonly acknowledged = signal(false);
  protected readonly ackError = signal(false);

  /** Prywatne elementy dopiero zaczna trafiac do historii: wymaga to osobnego potwierdzenia (sprawdza je tez main). */
  protected readonly needsAcknowledgement = computed(() => {
    const saved = this.state();
    const granted = saved !== null && saved.enabled && saved.includePrivate;
    return this.enabled() && this.includePrivate() && !granted;
  });

  ngOnInit(): void {
    void this.reload();
  }

  protected async reload(): Promise<void> {
    this.load.set({ status: 'loading' });
    const result = await this.api.getState();
    if (!result.ok) {
      this.load.set({ status: 'error', message: result.error.message });
      return;
    }
    this.apply(result.value);
    this.load.set({ status: 'ready' });
  }

  private apply(state: VersioningStateDto): void {
    this.state.set(state);
    this.enabled.set(state.enabled);
    this.includePrivate.set(state.includePrivate);
    this.acknowledged.set(false);
    this.ackError.set(false);
  }

  protected setEnabled(checked: boolean): void {
    this.enabled.set(checked);
    this.touch();
  }

  protected setIncludePrivate(checked: boolean): void {
    this.includePrivate.set(checked);
    if (!checked) {
      this.acknowledged.set(false);
      this.ackError.set(false);
    }
    this.touch();
  }

  protected setAcknowledged(checked: boolean): void {
    this.acknowledged.set(checked);
    if (checked) this.ackError.set(false);
    this.touch();
  }

  private touch(): void {
    if (this.save().status !== 'idle') this.save.set({ status: 'idle' });
  }

  protected async onSave(): Promise<void> {
    if (this.save().status === 'saving') return;
    if (this.needsAcknowledgement() && !this.acknowledged()) {
      this.ackError.set(true);
      document.getElementById('versioning-ack')?.focus();
      return;
    }
    this.save.set({ status: 'saving' });
    const result = await this.api.setSettings({
      enabled: this.enabled(),
      includePrivate: this.includePrivate(),
      acknowledged: this.acknowledged(),
      nonce: this.state()?.consentNonce ?? '',
    });
    if (!result.ok) {
      this.save.set({ status: 'error', message: result.error.message });
      // Znacznik zgody jest jednorazowy: po bledzie trzeba pobrac nowy, zeby ponowienie mialo szanse.
      const fresh = await this.api.getState();
      if (fresh.ok) this.state.set(fresh.value);
      return;
    }
    this.apply(result.value);
    this.save.set({ status: 'saved' });
  }
}
