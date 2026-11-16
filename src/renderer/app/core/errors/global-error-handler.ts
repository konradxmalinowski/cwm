import { ErrorHandler, Injectable } from '@angular/core';

/** Prefiks, po ktorym proces glowny rozpoznaje wpis do pliku logu (`registerCrashHandlers`). */
const PREFIX = '[cwm][renderer]';

/**
 * Globalny ErrorHandler. Nieobsluzony blad w komponencie albo obietnicy trafia do konsoli z
 * prefiksem, a proces glowny przepisuje go do logu z redakcja sekretow. Bez nowego kanalu IPC.
 * Logujemy tylko nazwe i komunikat, bez stosu i bez obiektu bledu.
 */
@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  handleError(error: unknown): void {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : 'nieznany';
    console.error(`${PREFIX} nieobsluzony blad:`, text);
  }
}
