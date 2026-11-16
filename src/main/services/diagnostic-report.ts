import { basename, extname, resolve, sep } from 'node:path';

import type { DiagnosticsReport } from '../../core/model/diagnostics';
import type { ListResult } from '../../core/services/library/library-service';
import type { DetectedRoot } from '../../core/ports/tool-adapter';
import type { Clock } from '../../core/ports/clock';
import {
  REPORT_LOG_LINES,
  buildReport,
  reportFileName,
  type ReportLibrarySummary,
  type ReportTool,
} from '../../core/services/diagnostics/report-builder';
import {
  createReportRedactor,
  type RedactableItem,
} from '../../core/services/diagnostics/report-redactor';
import { AtomicWriteError } from '../../infra/fs/atomic';
import type { ReportPreviewDto, ReportSaveDto } from '../../shared/ipc/diagnostics-contract';
import type { Result } from '../../shared/ipc/library-contract';

/** Podglad zyje krotko: po tym czasie uzytkownik dostaje swiezy raport, nie stary stan. */
export const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_PREVIEWS = 4;
const ALLOWED_EXTENSIONS = new Set(['.md', '.txt']);

export interface DiagnosticReportDeps {
  readonly diagnostics: () => Promise<DiagnosticsReport>;
  /** `null`, gdy biblioteka jest niedostepna. */
  readonly list: () => Promise<ListResult> | null;
  /** `null`, gdy import (a z nim wykrywanie lokalizacji) jest niedostepny. */
  readonly detect: () => Promise<readonly DetectedRoot[]> | null;
  readonly readLog: (maxLines: number) => string[];
  readonly redactHome: (text: string) => string;
  readonly userName: string | null;
  readonly clock: Clock;
  readonly newId: () => string;
  /** Okno zapisu wybiera main. `null` znaczy, ze uzytkownik je zamknal bez wyboru. */
  readonly pickPath: (suggestedName: string) => Promise<string | null>;
  readonly writeFile: (path: string, text: string) => Promise<void>;
  /** Katalogi konfiguracji narzedzi i danych aplikacji: raport nie trafia do nich. */
  readonly protectedRoots: readonly string[];
  readonly logUnexpected: (error: unknown) => void;
}

interface StoredPreview {
  readonly text: string;
  readonly fileName: string;
  readonly expiresAt: number;
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function err(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

const WRITE_FAILURE_TEXT: Readonly<Record<string, string>> = {
  'permission-denied': 'Brak uprawnień do zapisu w wybranym miejscu.',
  'read-only': 'Wybrane miejsce jest tylko do odczytu.',
  'no-space': 'Na dysku brakuje miejsca.',
  busy: 'Plik jest zablokowany przez inny program.',
  'missing-directory': 'Wybrany katalog nie istnieje.',
};

export function summarizeLibrary(result: ListResult): ReportLibrarySummary {
  const countsByKind: Record<string, number> = {};
  for (const item of result.items) {
    countsByKind[item.kind] = (countsByKind[item.kind] ?? 0) + 1;
  }
  return {
    total: result.items.length,
    countsByKind,
    problems: result.problems.length,
    inconsistent: result.inconsistent.length,
  };
}

function redactableItems(result: ListResult): RedactableItem[] {
  const items: RedactableItem[] = result.items.map((item) => ({
    kind: item.kind,
    names: [
      item.identity.slug,
      item.content.title,
      ...(item.identity.declaredName === null ? [] : [item.identity.declaredName]),
      ...item.identity.aliases,
    ],
  }));
  for (const broken of result.inconsistent) {
    items.push({ kind: broken.kind, names: [broken.slug] });
  }
  return items;
}

function toTool(root: DetectedRoot): ReportTool {
  return {
    tool: root.tool,
    kind: root.kind,
    label: root.label,
    exists: root.exists,
    active: root.active,
  };
}

/** Czy `candidate` lezy w `root` albo jest nim; porownanie bez rozrozniania wielkosci liter. */
export function isInside(candidate: string, root: string): boolean {
  const c = resolve(candidate).toLowerCase();
  const r = resolve(root).toLowerCase();
  return c === r || c.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}

export class DiagnosticReportService {
  private readonly previews = new Map<string, StoredPreview>();

  constructor(private readonly deps: DiagnosticReportDeps) {}

  async preview(): Promise<Result<ReportPreviewDto>> {
    try {
      const diagnostics = await this.deps.diagnostics();
      const listing = await this.safe(() => this.deps.list());
      const roots = await this.safe(() => this.deps.detect());
      const redactor = createReportRedactor({
        redactHome: this.deps.redactHome,
        userName: this.deps.userName,
        items: listing === null ? [] : redactableItems(listing),
      });
      const built = buildReport(
        {
          diagnostics,
          library: listing === null ? null : summarizeLibrary(listing),
          tools: roots === null ? null : roots.map(toTool),
          logLines: this.deps.readLog(REPORT_LOG_LINES),
        },
        redactor,
      );
      const fileName = reportFileName(this.deps.clock.now().toISOString());
      const previewId = this.deps.newId();
      this.remember(previewId, { text: built.text, fileName });
      return ok({
        previewId,
        text: built.text,
        fileName,
        lineCount: built.text.split('\n').length,
        logLineCount: built.logLineCount,
      });
    } catch (error: unknown) {
      this.deps.logUnexpected(error);
      return err('internal', 'Nie udało się przygotować raportu. Szczegóły są w logu aplikacji.');
    }
  }

  async save(previewId: string): Promise<Result<ReportSaveDto>> {
    const stored = this.previews.get(previewId);
    if (stored === undefined || stored.expiresAt < this.deps.clock.now().getTime()) {
      this.previews.delete(previewId);
      return err('preview-expired', 'Podgląd raportu wygasł. Otwórz raport ponownie.');
    }
    try {
      const chosen = await this.deps.pickPath(stored.fileName);
      if (chosen === null) return ok({ status: 'cancelled' });
      const target = ALLOWED_EXTENSIONS.has(extname(chosen).toLowerCase())
        ? chosen
        : `${chosen}.md`;
      if (this.deps.protectedRoots.some((root) => isInside(target, root))) {
        return err(
          'forbidden-location',
          'Raport nie zapisze się w katalogu konfiguracji narzędzia ani w katalogu danych aplikacji. Wybierz inne miejsce.',
        );
      }
      await this.deps.writeFile(target, stored.text);
      this.previews.delete(previewId);
      return ok({ status: 'saved', fileName: basename(target) });
    } catch (error: unknown) {
      if (error instanceof AtomicWriteError) {
        return err(
          error.reason,
          `Nie udało się zapisać pliku. ${WRITE_FAILURE_TEXT[error.reason] ?? 'Zapis nie powiódł się.'}`,
        );
      }
      this.deps.logUnexpected(error);
      return err('internal', 'Nie udało się zapisać pliku. Szczegóły są w logu aplikacji.');
    }
  }

  private async safe<T>(read: () => Promise<T> | null): Promise<T | null> {
    try {
      return (await read()) ?? null;
    } catch (error: unknown) {
      this.deps.logUnexpected(error);
      return null;
    }
  }

  private remember(id: string, preview: { text: string; fileName: string }): void {
    const now = this.deps.clock.now().getTime();
    for (const [key, value] of this.previews) {
      if (value.expiresAt < now) this.previews.delete(key);
    }
    while (this.previews.size >= MAX_PREVIEWS) {
      const oldest = this.previews.keys().next().value;
      if (oldest === undefined) break;
      this.previews.delete(oldest);
    }
    this.previews.set(id, { ...preview, expiresAt: now + PREVIEW_TTL_MS });
  }
}
