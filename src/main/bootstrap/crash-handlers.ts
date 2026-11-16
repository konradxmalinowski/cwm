import { app } from 'electron';

import type { Logger } from '../../infra/logging/logger';

/** Prefiks, ktorym renderer oznacza wpisy przeznaczone do pliku logu procesu glownego. */
export const RENDERER_ERROR_PREFIX = '[cwm][renderer]';

const MAX_RENDERER_LINE = 500;
const MAX_RELOADS = 3;
const RELOAD_WINDOW_MS = 60_000;

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'nieznany';
}

/**
 * Awarie na poziomie procesu (ADR 0014, ARCHITECTURE 8.4). Wszystko idzie przez logger, ktory
 * redaguje sekrety i katalog domowy; tresc bledu to tylko nazwa i komunikat, bez stosu.
 *
 * Wlasny handler `uncaughtException` wylacza domyslne modalne okno Electrona, ktore czeka na
 * klik i trzyma proces przy zyciu (na Windowsie razem z plikami katalogu danych), wiec zadnych
 * dialogow tu nie pokazujemy.
 */
export function registerCrashHandlers(log: () => Logger, now: () => number = Date.now): void {
  process.on('uncaughtException', (error) => {
    log().error('[cwm] nieobsluzony wyjatek:', describeError(error));
  });

  process.on('unhandledRejection', (reason) => {
    log().error('[cwm] nieobsluzone odrzucenie obietnicy:', describeError(reason));
  });

  const reloads: number[] = [];

  app.on('render-process-gone', (_event, contents, details) => {
    log().error(
      '[cwm] proces renderera zakonczony:',
      details.reason,
      `kod ${String(details.exitCode)}`,
    );
    if (details.reason === 'clean-exit' || contents.isDestroyed()) return;

    // Przeladowanie to jedyne odzyskanie: dane sa w plikach i indeksie, nie w oknie. Petla
    // awarii konczy sie po MAX_RELOADS w minute, a okno zostaje puste zamiast mielic procesor.
    const cutoff = now() - RELOAD_WINDOW_MS;
    while (reloads.length > 0 && (reloads[0] ?? 0) < cutoff) reloads.shift();
    if (reloads.length >= MAX_RELOADS) {
      log().error('[cwm] renderer pada w petli, przeladowanie wstrzymane');
      return;
    }
    reloads.push(now());
    contents.reload();
  });

  app.on('child-process-gone', (_event, details) => {
    log().error(
      '[cwm] proces potomny zakonczony:',
      details.type,
      details.reason,
      `kod ${String(details.exitCode)}`,
    );
  });

  // Renderer nie ma wlasnego kanalu logu (nowy IPC bylby nowa powierzchnia ataku); jego globalny
  // ErrorHandler pisze do konsoli z prefiksem, a tu trafia to do pliku logu.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', (event) => {
      if (event.level !== 'error' || !event.message.startsWith(RENDERER_ERROR_PREFIX)) return;
      log().error(event.message.slice(0, MAX_RENDERER_LINE));
    });
  });
}
