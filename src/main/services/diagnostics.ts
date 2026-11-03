import type { DatabaseProbe, DiagnosticsReport, RuntimeInfo } from '../../core/model/diagnostics';
import type { IndexStartupInfo } from '../../core/model/index-health';
import type { Clock } from '../../core/ports/clock';
import type { IndexStore } from '../../core/ports/index-store';

export interface DiagnosticsDeps {
  readonly runtime: RuntimeInfo;
  /**
   * `null`, jesli aplikacja wystartowala bez indeksu (ADR 0029). Okno istnieje
   * niezaleznie od indeksu, wiec raport musi umiec opisac ten stan, a nie
   * zalozyc, ze indeks jest.
   */
  readonly indexStore: IndexStore | null;
  readonly index: IndexStartupInfo;
  readonly clock: Clock;
  readonly appIcon: 'placeholder' | 'provided';
  readonly stage: string;
}

const PATH_TOKEN = /(?:[A-Za-z]:[\\/]|~[\\/]|\/)[^\s"'`)\]]*/g;

/**
 * ARCHITECTURE 7.2 regula 4: renderer nie dostaje sciezek. Fragment wygladajacy na sciezke
 * (absolutna, `~/` albo z dyskiem) zostaje sprowadzony do ostatniego segmentu, takze w
 * komunikatach bledow, ktore niosa sciezke z biblioteki natywnej albo z `Error.message`.
 */
export function stripPaths(text: string): string {
  return text.replace(PATH_TOKEN, (match) => {
    const parts = match.split(/[\\/]/).filter((part) => part.length > 0 && part !== '~');
    return parts[parts.length - 1] ?? '';
  });
}

const LOCATION_LABEL = 'index.db (katalog danych aplikacji)';

function sanitizeProbe(probe: DatabaseProbe): DatabaseProbe {
  if (probe.status === 'ok') return { ...probe, locationLabel: LOCATION_LABEL };
  if (probe.status === 'failed') {
    return { ...probe, reason: stripPaths(probe.reason), locationLabel: LOCATION_LABEL };
  }
  return { ...probe, reason: stripPaths(probe.reason) };
}

function sanitizeIndex(info: IndexStartupInfo): IndexStartupInfo {
  const { quarantinedAs, message, notRestored, ...rest } = info;
  return {
    ...rest,
    ...(message === undefined ? {} : { message: stripPaths(message) }),
    // Nazwa pliku w kwarantannie wystarcza do jego znalezienia, katalog nie wychodzi.
    ...(quarantinedAs === undefined ? {} : { quarantinedAs: stripPaths(quarantinedAs) }),
    ...(notRestored === undefined ? {} : { notRestored: notRestored.map(stripPaths) }),
  };
}

export function buildDiagnosticsReport(deps: DiagnosticsDeps): DiagnosticsReport {
  return {
    generatedAt: deps.clock.now().toISOString(),
    runtime: deps.runtime,
    database: sanitizeProbe(
      deps.indexStore === null
        ? { status: 'unavailable', reason: deps.index.message ?? 'indeks nie zostal otwarty' }
        : deps.indexStore.probe(),
    ),
    index: sanitizeIndex(deps.index),
    appIcon: deps.appIcon,
    stage: deps.stage,
  };
}
