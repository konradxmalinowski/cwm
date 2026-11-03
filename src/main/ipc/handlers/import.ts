import { LibraryError } from '../../../core/model/library-errors';
import {
  ImportError,
  type ApplyReport,
  type ImportService,
  type ScanReport,
} from '../../../core/services/import/import-service';
import type { DetectedRoot } from '../../../core/ports/tool-adapter';
import type {
  CandidateDto,
  DetectedRootDto,
  ImportApplyDto,
  ImportDetectDto,
  ImportScanDto,
  SkippedDto,
} from '../../../shared/ipc/import-contract';
import type { Result } from '../../../shared/ipc/library-contract';
import type { IpcRegistry } from '../registry';
import { parseApplyRequest, parseScanRequest } from './import-validation';
import type { Parsed } from './library-validation';

const UNAVAILABLE_MESSAGE =
  'Import jest niedostępny: biblioteka nie została przygotowana. Sprawdź uprawnienia katalogu danych aplikacji i uruchom ją ponownie.';
const INTERNAL_MESSAGE = 'Wystąpił nieoczekiwany błąd importu. Szczegóły są w logu aplikacji.';

export interface ImportHandlerDeps {
  /** `null`, gdy biblioteka jest niedostepna: kanaly odpowiadaja bledem, aplikacja dziala. */
  readonly service: () => ImportService | null;
  readonly logUnexpected?: (error: unknown) => void;
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function err(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

function mapError(error: unknown, logUnexpected: (e: unknown) => void): Result<never> {
  if (error instanceof ImportError) return err(error.code, error.message);
  if (error instanceof LibraryError) return err(error.reason, error.message);
  logUnexpected(error);
  return err('internal', INTERNAL_MESSAGE);
}

function toRootDto(root: DetectedRoot): DetectedRootDto {
  return {
    rootId: root.rootId,
    tool: root.tool,
    kind: root.kind,
    label: root.label,
    exists: root.exists,
    active: root.active,
  };
}

/** Odpowiedz budowana jawnie, pole po polu: draft, bajty i `rootId` kandydata nie wychodza do renderera. */
function toScanDto(report: ScanReport): ImportScanDto {
  const candidates: CandidateDto[] = report.candidates.map((c) => ({
    candidateId: c.candidateId,
    tool: c.candidate.tool,
    rootLabel: c.rootLabel,
    relPath: c.candidate.relPath,
    kind: c.candidate.kind,
    slug: c.candidate.draft.identity.slug,
    title: c.candidate.draft.content.title,
    description: c.candidate.draft.content.description,
    status: c.status,
    existingItemId: c.existingItemId,
    duplicateOf: c.duplicateOf,
    secrets: c.secrets.map((s) => ({
      rule: s.rule,
      file: s.relPath,
      line: s.line,
      reason: s.reason,
    })),
    warnings: c.candidate.warnings.map((w) => ({ code: w.code, message: w.message })),
    selectedByDefault: c.selectedByDefault,
  }));
  const skipped: SkippedDto[] = report.skipped.map((s) => ({
    tool: s.tool,
    rootLabel: s.rootLabel,
    relPath: s.relPath,
    reason: s.reason,
    message: s.message,
  }));
  return { scanToken: report.scanToken, candidates, skipped };
}

function toApplyDto(report: ApplyReport): ImportApplyDto {
  return {
    imported: report.imported.map((i) => ({ ...i })),
    skipped: report.skipped.map((s) => ({ candidateId: s.candidateId, reason: s.reason })),
    failed: report.failed.map((f) => ({
      candidateId: f.candidateId,
      code: f.code,
      message: f.message,
    })),
  };
}

export function registerImportHandlers(registry: IpcRegistry, deps: ImportHandlerDeps): void {
  const logUnexpected = deps.logUnexpected ?? ((): void => undefined);

  function guarded<P, T>(
    parse: (payload: unknown) => Parsed<P>,
    run: (service: ImportService, request: P) => Promise<Result<T>>,
  ): (payload: unknown) => Promise<Result<T>> {
    return async (payload) => {
      const parsed = parse(payload);
      if (!parsed.ok) return err('invalid-request', parsed.message);
      const service = deps.service();
      if (service === null) return err('import-unavailable', UNAVAILABLE_MESSAGE);
      try {
        return await run(service, parsed.value);
      } catch (error: unknown) {
        return mapError(error, logUnexpected);
      }
    };
  }

  // `import:detect` nie ma parametrow; ladunek jest ignorowany, nie interpretowany.
  registry.register(
    'import:detect',
    guarded(
      (): Parsed<null> => ({ ok: true, value: null }),
      async (service): Promise<Result<ImportDetectDto>> =>
        ok({ roots: (await service.detect()).map(toRootDto) }),
    ),
  );

  registry.register(
    'import:scan',
    guarded(parseScanRequest, async (service, request) =>
      ok(toScanDto(await service.scan(request.rootIds))),
    ),
  );

  registry.register(
    'import:apply',
    guarded(parseApplyRequest, async (service, request) =>
      ok(toApplyDto(await service.apply(request))),
    ),
  );
}
