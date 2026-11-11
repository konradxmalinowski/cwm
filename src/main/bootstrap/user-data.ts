import { join } from 'node:path';

import { app, dialog } from 'electron';

import type { DataMigrationInfo } from '../../core/model/data-migration';
import {
  markMigrationSkipped,
  migrateLegacyUserData,
  USER_DATA_DIR_NAME,
} from '../../infra/store/user-data-migration';

/**
 * Ustawia katalog danych na `<appData>/CWM` i przenosi dane z v0.1.0. Wolac przed `ready`
 * i przed `requestSingleInstanceLock`. Jawne `--user-data-dir` (testy, uruchomienia
 * przenosne) wygrywa i wylacza migracje.
 */
export function configureUserData(): DataMigrationInfo {
  if (app.commandLine.hasSwitch('user-data-dir')) return { outcome: 'none' };
  const appData = app.getPath('appData');
  app.setPath('userData', join(appData, USER_DATA_DIR_NAME));
  return migrateLegacyUserData(appData);
}

export type MigrationDecision =
  { readonly proceed: true; readonly info: DataMigrationInfo } | { readonly proceed: false };

/**
 * Po `ready`, przed indeksem i oknem. Nieudana albo odlozona migracja zatrzymuje start, dopoki
 * uzytkownik nie wybierze: zamknac (nic nie jest zapisane, nastepny start ponowi probe) albo
 * zaczac z pusta biblioteka (zapisuje znacznik `skipped`, wiec migracja nie wroci).
 */
export function resolveMigration(info: DataMigrationInfo): MigrationDecision {
  if (info.outcome !== 'failed' && info.outcome !== 'deferred') {
    return { proceed: true, info };
  }
  const detail =
    info.outcome === 'deferred'
      ? 'Starsza wersja aplikacji (Universal AI Skills Manager) jest uruchomiona. Zamknij ją i uruchom CWM ponownie, a dane zostaną przeniesione. Stare dane nie zostały zmienione.'
      : `Nie udało się przenieść danych z poprzedniej wersji (kod błędu: ${info.errorCode ?? 'nieznany'}). Stare dane nie zostały zmienione. Uruchom CWM ponownie, a jeśli problem wraca, zajrzyj do docs/ODZYSKIWANIE.md.`;
  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    title: 'CWM',
    message:
      info.outcome === 'deferred'
        ? 'Dane nie zostały jeszcze przeniesione'
        : 'Nie udało się przenieść danych',
    detail: `${detail}\n\nZacznij z pustą biblioteką tylko wtedy, gdy nie potrzebujesz starych danych. Ta decyzja nie jest ponawiana.`,
    buttons: ['Zamknij', 'Zacznij z pustą biblioteką'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (choice !== 1) return { proceed: false };
  markMigrationSkipped(app.getPath('userData'));
  return { proceed: true, info: { ...info, outcome: 'skipped' } };
}
