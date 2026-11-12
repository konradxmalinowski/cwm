import { lstatLoose, type CwmLayout } from '../../infra/cwm';
import { failure } from '../context';

/** Polecenia poza `init` wymagaja istniejacego katalogu danych i konfiguracji globalnej. */
export async function requireInitialized(layout: CwmLayout): Promise<void> {
  if ((await lstatLoose(layout.home)) === null || (await lstatLoose(layout.configFile)) === null) {
    throw failure(`Brak danych CWM w ${layout.home}. Uruchom: cwm init`);
  }
}
