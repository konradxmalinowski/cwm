import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  type OnInit,
} from '@angular/core';

import { hasRetentionLimits, RETENTION_BOUNDS } from '../../../../core/model/retention';
import type { RetentionSettingsDto } from '../../../../shared/ipc/retention-contract';
import { RetentionApiService } from '../../core/ipc/retention-api.service';
import { formatBytes } from '../../core/labels';
import {
  RETENTION_FIELDS,
  blockedText,
  formFromSettings,
  hasChanges,
  parseForm,
  sameSettings,
  type RetentionField,
  type RetentionForm,
  type RetentionFormErrors,
  type RetentionRunState,
} from './retention-model';

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready' }
  | { readonly status: 'error'; readonly message: string };

type SaveState =
  | { readonly status: 'idle' }
  | { readonly status: 'saving' }
  | { readonly status: 'saved' }
  | { readonly status: 'error'; readonly message: string };

const FIELD_META: Readonly<Record<RetentionField, { id: string; label: string; hint: string }>> = {
  maxEntries: {
    id: 'retention-entries',
    label: 'Najwięcej wpisów historii',
    hint: 'Starsze wpisy ponad limit są przycinane. Puste pole: bez limitu.',
  },
  maxAgeDays: {
    id: 'retention-age',
    label: 'Najdłuższy wiek wpisu (dni)',
    hint: 'Wpisy starsze niż tyle dni są przycinane. Puste pole: bez limitu.',
  },
  maxStoreMiB: {
    id: 'retention-size',
    label: 'Najwięcej danych w content store (MiB)',
    hint: 'Gdy obiekty potrzebne zachowanym wpisom są większe, przycinane są kolejne najstarsze wpisy. Puste pole: bez limitu.',
  },
};

@Component({
  selector: 'app-retention-section',
  templateUrl: './retention-section.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RetentionSectionComponent implements OnInit {
  private readonly api = inject(RetentionApiService);

  protected readonly fields = RETENTION_FIELDS;
  protected readonly meta = FIELD_META;
  protected readonly bounds = RETENTION_BOUNDS;
  protected readonly blockedText = blockedText;
  protected readonly hasChanges = hasChanges;
  protected readonly formatBytes = formatBytes;

  protected readonly load = signal<LoadState>({ status: 'loading' });
  protected readonly save = signal<SaveState>({ status: 'idle' });
  protected readonly run = signal<RetentionRunState>({ status: 'idle' });
  protected readonly saved = signal<RetentionSettingsDto | null>(null);
  protected readonly form = signal<RetentionForm>({
    maxEntries: '',
    maxAgeDays: '',
    maxStoreMiB: '',
  });

  protected readonly parsed = computed(() => parseForm(this.form()));
  protected readonly errors = computed<RetentionFormErrors>(() => {
    const result = this.parsed();
    return result.ok ? {} : result.errors;
  });
  /** Podglad liczy na zapisanych ustawieniach, wiec niezapisana zmiana pol blokuje przyciski czyszczenia. */
  protected readonly dirty = computed(() => {
    const result = this.parsed();
    const saved = this.saved();
    return !result.ok || saved === null || !sameSettings(result.value, saved);
  });
  protected readonly automatic = computed(() => {
    const saved = this.saved();
    return saved !== null && hasRetentionLimits(saved);
  });

  ngOnInit(): void {
    void this.reload();
  }

  protected async reload(): Promise<void> {
    this.load.set({ status: 'loading' });
    const result = await this.api.getSettings();
    if (!result.ok) {
      this.load.set({ status: 'error', message: result.error.message });
      return;
    }
    this.saved.set(result.value);
    this.form.set(formFromSettings(result.value));
    this.load.set({ status: 'ready' });
  }

  protected onInput(field: RetentionField, value: string): void {
    this.form.update((form) => ({ ...form, [field]: value }));
    if (this.save().status !== 'idle') this.save.set({ status: 'idle' });
    if (this.run().status !== 'idle') this.run.set({ status: 'idle' });
  }

  protected async saveSettings(): Promise<void> {
    const result = this.parsed();
    if (!result.ok || this.save().status === 'saving') return;
    this.save.set({ status: 'saving' });
    const response = await this.api.setSettings(result.value);
    if (!response.ok) {
      this.save.set({ status: 'error', message: response.error.message });
      return;
    }
    this.saved.set(response.value);
    this.form.set(formFromSettings(response.value));
    this.save.set({ status: 'saved' });
    this.run.set({ status: 'idle' });
  }

  protected async openPreview(): Promise<void> {
    if (this.dirty()) return;
    this.run.set({ status: 'working' });
    const result = await this.api.preview();
    this.run.set(
      result.ok
        ? { status: 'preview', report: result.value, acknowledged: false }
        : { status: 'error', step: 'preview', message: result.error.message },
    );
  }

  protected acknowledge(checked: boolean): void {
    const state = this.run();
    if (state.status === 'preview') this.run.set({ ...state, acknowledged: checked });
  }

  protected cancel(): void {
    this.run.set({ status: 'idle' });
  }

  protected async apply(): Promise<void> {
    const state = this.run();
    if (state.status !== 'preview' || !state.acknowledged || !hasChanges(state.report)) return;
    this.run.set({ status: 'applying', report: state.report });
    const result = await this.api.apply();
    this.run.set(
      result.ok
        ? { status: 'done', report: result.value }
        : { status: 'error', step: 'apply', message: result.error.message },
    );
  }
}
