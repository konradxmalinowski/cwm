import { basename, dirname, extname, join } from 'node:path';

import type { ItemId, ToolId } from '../../core/model/item';
import type { Clock } from '../../core/ports/clock';
import type { OperationLog } from '../../core/ports/operation-log';
import { ExportError } from '../../core/services/export/export-service';
import type {
  ZipExportService,
  ZipPayload,
  ZipPlanReport,
} from '../../core/services/export/zip-export-service';
import { AtomicWriteError } from '../../infra/fs/atomic';
import type { ExportZipSaveDto } from '../../shared/ipc/export-contract';
import type { Result } from '../../shared/ipc/library-contract';
import type { ZipPort } from '../ipc/handlers/export';
import { WRITE_FAILURE_TEXT, isInside } from './diagnostic-report';

/** Wpis w historii nie dotyczy zadnego elementu: jego `itemId` to stala (jak `index` przy odbudowie). */
const ZIP_ITEM_ID = 'zip-export' as ItemId;
const ZIP_EXTENSION = '.zip';

export interface ZipSaveDeps {
  /** `null`, gdy eksport nie jest jeszcze przygotowany (biblioteka albo katalog lokalizacji). */
  readonly service: () => ZipExportService | null;
  /** Okno zapisu wybiera main. `null` znaczy, ze uzytkownik je zamknal bez wyboru. */
  readonly pickPath: (suggestedName: string) => Promise<string | null>;
  readonly writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
  readonly exists: (path: string) => boolean;
  /** Sciezka po rozwinieciu dowiazan; gdy sie nie da, ta sama sciezka. */
  readonly realpath: (path: string) => string;
  /** Katalogi konfiguracji narzedzi i danych aplikacji: archiwum nie trafia do nich (ADR 0053). */
  readonly protectedRoots: readonly string[];
  readonly log: OperationLog;
  readonly clock: Clock;
  readonly logUnexpected: (error: unknown) => void;
}

function err(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

/**
 * Zapis archiwum ZIP z planu (ADR 0054). Te same reguly co przy raporcie diagnostycznym (ADR 0053):
 * okno zapisu i sciezka tylko w main, odmowa w katalogach konfiguracji i danych aplikacji, zapis
 * atomowy, brak cichego nadpisania pliku, ktorego okno systemowe nie widzialo.
 */
export class ZipSaveService implements ZipPort {
  constructor(private readonly deps: ZipSaveDeps) {}

  private zip(): ZipExportService {
    const service = this.deps.service();
    if (service === null) {
      throw new ExportError(
        'export-unavailable',
        'Eksport jest niedostępny: biblioteka lub katalog lokalizacji nie zostały przygotowane.',
      );
    }
    return service;
  }

  /** Asynchroniczne, zeby brak serwisu byl odrzuconym wynikiem, a nie wyjatkiem w miejscu wywolania. */
  async plan(
    tool: ToolId,
    itemIds: readonly string[],
    confirmedItemIds: readonly string[],
  ): Promise<ZipPlanReport> {
    return await this.zip().plan(tool, itemIds, confirmedItemIds);
  }

  async save(planId: string): Promise<Result<ExportZipSaveDto>> {
    let payload: ZipPayload;
    try {
      payload = this.zip().peek(planId);
    } catch (error: unknown) {
      if (error instanceof ExportError) return err(error.code, error.message);
      throw error;
    }
    try {
      const chosen = await this.deps.pickPath(payload.fileName);
      if (chosen === null) return { ok: true, value: { status: 'cancelled' } };
      const hasExtension = extname(chosen).toLowerCase() === ZIP_EXTENSION;
      const target = hasExtension ? chosen : `${chosen}${ZIP_EXTENSION}`;
      // Okno zapisu pytalo o nadpisanie nazwy bez rozszerzenia, a nie tej z `.zip`.
      if (!hasExtension && this.deps.exists(target)) {
        return err(
          'target-exists',
          `Plik ${basename(target)} już istnieje. Wybierz nazwę z rozszerzeniem .zip albo inne miejsce.`,
        );
      }
      const real = join(this.deps.realpath(dirname(target)), basename(target));
      const roots = this.deps.protectedRoots.flatMap((root) => [root, this.deps.realpath(root)]);
      if (roots.some((root) => isInside(target, root) || isInside(real, root))) {
        return err(
          'forbidden-location',
          'Archiwum nie zapisze się w katalogu konfiguracji narzędzia ani w katalogu danych aplikacji. Wybierz inne miejsce.',
        );
      }
      await this.deps.writeFile(target, payload.bytes);
      this.zip().consume(planId);
      await this.record(payload);
      return {
        ok: true,
        value: { status: 'saved', fileName: basename(target), fileCount: payload.fileCount },
      };
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

  /** Wpis w historii: cel, liczby, bez sciezki. Awaria logu nie zamienia udanego zapisu w blad. */
  private async record(payload: ZipPayload): Promise<void> {
    try {
      await this.deps.log.append({
        operation: 'export-zip',
        itemId: ZIP_ITEM_ID,
        itemKind: null,
        slug: null,
        at: this.deps.clock.now().toISOString(),
        before: null,
        after: null,
        note: `cel=zip; uklad=${payload.tool}; pliki=${payload.fileCount}; elementy=${payload.itemCount}`,
      });
    } catch (error: unknown) {
      this.deps.logUnexpected(error);
    }
  }
}
