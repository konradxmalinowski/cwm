import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  type OnInit,
} from '@angular/core';

import { hasRetentionLimits, RETENTION_BOUNDS } from '../../../../core/model/retention';
import type {
  RetentionBlockedDto,
  RetentionSettingsDto,
} from '../../../../shared/ipc/retention-contract';
import { RetentionApiService } from '../../core/ipc/retention-api.service';
import { formatBytes } from '../../core/labels';
import {
  RETENTION_FIELDS,
  blockedText,
  formFromSettings,
  hasChanges,
  isTightening,
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
  /** Powod, dla ktorego czyszczenie przy starcie tej sesji niczego nie zrobilo. */
  protected readonly startupNotice = signal<RetentionBlockedDto | null>(null);
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
  /** Zapis wlacza albo zmniejsza limit: najpierw podglad i potwierdzenie. */
  protected readonly tightening = computed(() => {
    const result = this.parsed();
    const saved = this.saved();
    return result.ok && saved !== null && isTightening(saved, result.value);
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
    this.startupNotice.set(result.value.startupNotice);
    this.applySaved(result.value);
    this.load.set({ status: 'ready' });
  }

  private applySaved(settings: RetentionSettingsDto): void {
    const plain = {
      maxEntries: settings.maxEntries,
      maxAgeDays: settings.maxAgeDays,
      maxStoreMiB: settings.maxStoreMiB,
    };
    this.saved.set(plain);
    this.form.set(formFromSettings(plain));
  }

  protected onInput(field: RetentionField, value: string): void {
    this.form.update((form) => ({ ...form, [field]: value }));
    if (this.save().status !== 'idle') this.save.set({ status: 'idle' });
    if (this.run().status !== 'idle') this.run.set({ status: 'idle' });
  }

  /** Zaostrzenie limitu idzie przez podglad i potwierdzenie; poluzowanie zapisuje sie od razu. */
  protected async onSave(): Promise<void> {
    if (this.tightening()) {
      await this.openPreview('save');
      return;
    }
    await this.persist(false);
  }

  private async persist(confirmed: boolean): Promise<boolean> {
    const result = this.parsed();
    if (!result.ok || this.save().status === 'saving') return false;
    this.save.set({ status: 'saving' });
    const response = await this.api.setSettings(result.value, confirmed);
    if (!response.ok) {
      this.save.set({ status: 'error', message: response.error.message });
      return false;
    }
    this.applySaved(response.value);
    this.save.set({ status: 'saved' });
    return true;
  }

  protected async openPreview(intent: 'save' | 'clean'): Promise<void> {
    const result = this.parsed();
    if (!result.ok) return;
    this.run.set({ status: 'working' });
    const response = await this.api.preview(this.dirty() ? result.value : undefined);
    this.run.set(
      response.ok
        ? { status: 'preview', report: response.value, intent, acknowledged: false }
        : { status: 'error', step: 'preview', message: response.error.message },
    );
  }

  protected acknowledge(checked: boolean): void {
    const state = this.run();
    if (state.status === 'preview') this.run.set({ ...state, acknowledged: checked });
  }

  protected cancel(): void {
    this.run.set({ status: 'idle' });
  }

  /** Podglad przed zapisem zaostrzonego limitu nie ma nic do usuniecia, ale zapis nadal wymaga potwierdzenia. */
  protected canSaveWithoutChanges(): boolean {
    const state = this.run();
    return state.status === 'applying' || (state.status === 'preview' && state.intent === 'save');
  }

  protected confirmLabel(): string {
    const state = this.run();
    if (state.status === 'applying') return 'Pracuję…';
    if (state.status === 'preview' && state.intent === 'save') return 'Zapisz ustawienia';
    return this.dirty() ? 'Zapisz i wyczyść teraz' : 'Wyczyść teraz';
  }

  /** Zapisuje limity (z potwierdzeniem), a dla "Wyczyść teraz" wykonuje przebieg z tokenem podgladu. */
  protected async confirm(): Promise<void> {
    const state = this.run();
    if (state.status !== 'preview' || !state.acknowledged) return;
    const { report, intent } = state;
    const token = report.previewToken;
    if (intent === 'clean' && (!hasChanges(report) || token === null)) return;
    this.run.set({ status: 'applying', report });
    if (this.dirty() || intent === 'save') {
      if (!(await this.persist(true))) {
        const failed = this.save();
        this.run.set({
          status: 'error',
          step: 'apply',
          message: failed.status === 'error' ? failed.message : 'Nie zapisano ustawień.',
        });
        return;
      }
    }
    if (intent === 'save' || token === null) {
      this.run.set({ status: 'idle' });
      return;
    }
    const result = await this.api.apply(token);
    this.run.set(
      result.ok
        ? { status: 'done', report: result.value }
        : { status: 'error', step: 'apply', message: result.error.message },
    );
  }
}
