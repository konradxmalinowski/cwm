import { RETENTION_BOUNDS, RETENTION_FIELD_LABEL } from '../../../../core/model/retention';
import type {
  RetentionReportDto,
  RetentionSettingsDto,
} from '../../../../shared/ipc/retention-contract';

export type RetentionField = keyof RetentionSettingsDto;

export const RETENTION_FIELDS: readonly RetentionField[] = [
  'maxEntries',
  'maxAgeDays',
  'maxStoreMiB',
];

/** Pola formularza to tekst: puste pole znaczy brak limitu, a nie zero. */
export type RetentionForm = Readonly<Record<RetentionField, string>>;

export type RetentionFormErrors = Partial<Record<RetentionField, string>>;

export type RetentionFormParse =
  | { readonly ok: true; readonly value: RetentionSettingsDto }
  | { readonly ok: false; readonly errors: RetentionFormErrors };

export function formFromSettings(settings: RetentionSettingsDto): RetentionForm {
  const text = (value: number | null): string => (value === null ? '' : String(value));
  return {
    maxEntries: text(settings.maxEntries),
    maxAgeDays: text(settings.maxAgeDays),
    maxStoreMiB: text(settings.maxStoreMiB),
  };
}

/** Te same zakresy co w main (`parseRetentionSettings`); main i tak sprawdza je jeszcze raz. */
export function parseForm(form: RetentionForm): RetentionFormParse {
  const errors: { -readonly [K in RetentionField]?: string } = {};
  const value: { -readonly [K in RetentionField]: number | null } = {
    maxEntries: null,
    maxAgeDays: null,
    maxStoreMiB: null,
  };
  for (const field of RETENTION_FIELDS) {
    const raw = form[field].trim();
    if (raw === '') continue;
    const { min, max } = RETENTION_BOUNDS[field];
    const parsed = /^\d{1,9}$/.test(raw) ? Number(raw) : Number.NaN;
    if (Number.isNaN(parsed) || parsed < min || parsed > max) {
      const label = RETENTION_FIELD_LABEL[field];
      errors[field] = `${label}: liczba całkowita od ${min} do ${max} albo puste pole.`;
      continue;
    }
    value[field] = parsed;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, value };
}

export function sameSettings(a: RetentionSettingsDto, b: RetentionSettingsDto): boolean {
  return (
    a.maxEntries === b.maxEntries &&
    a.maxAgeDays === b.maxAgeDays &&
    a.maxStoreMiB === b.maxStoreMiB
  );
}

export type RetentionRunState =
  | { readonly status: 'idle' }
  | { readonly status: 'working' }
  | {
      readonly status: 'preview';
      readonly report: RetentionReportDto;
      readonly acknowledged: boolean;
    }
  | { readonly status: 'applying'; readonly report: RetentionReportDto }
  | { readonly status: 'done'; readonly report: RetentionReportDto }
  | { readonly status: 'error'; readonly step: 'preview' | 'apply'; readonly message: string };

const BLOCKED_TEXT: Readonly<Record<NonNullable<RetentionReportDto['blocked']>, string>> = {
  'library-unreadable':
    'Aplikacja nie potrafi odczytać wszystkich elementów biblioteki, więc nie może wykazać, które obiekty są jeszcze potrzebne. Nic nie zostanie usunięte. Napraw albo usuń uszkodzone elementy w Bibliotece.',
  'object-unreadable':
    'Nie da się odczytać któregoś z obiektów, na które wskazuje historia, więc nie wiadomo, co jeszcze od niego zależy. Nic nie zostanie usunięte.',
};

export function blockedText(blocked: NonNullable<RetentionReportDto['blocked']>): string {
  return BLOCKED_TEXT[blocked];
}

/** Czy przebieg cokolwiek zmieni: podglad bez zmian nie potrzebuje potwierdzenia ani przycisku. */
export function hasChanges(report: RetentionReportDto): boolean {
  return report.blocked === null && (report.entriesRemoved > 0 || report.objectsRemoved > 0);
}
