import type { EffectiveConfiguration } from './effective';
import { fail, type ValidationError, type ValidationResult } from './errors';
import { refKey } from './kinds';
import { dependenciesOf } from './resource';

/** Argument z sekretem podanym wprost, np. `--token=abc`. Sam argument bez wartosci jest w porzadku. */
const INLINE_SECRET_ARG = /^--?(?:token|password|passwd|secret|api[-_]?key|auth|bearer)=./i;
/** Adres z danymi logowania w czesci `user:pass@host`. */
const URL_USERINFO = /:\/\/[^/@\s]*:[^/@\s]*@/;

/**
 * Niezmienniki gotowej konfiguracji: jeden rodzaj na identyfikator, komplet zaleznosci,
 * zgodnosc z silnikiem profilu i brak sekretow wpisanych wprost. Bledy nie cytuja wartosci.
 * `handled` to klucze, o ktorych wywolujacy juz zglosil blad (np. zabroniony plugin): ich
 * brak w konfiguracji nie jest zglaszany drugi raz.
 */
export function validatePolicy(
  effective: EffectiveConfiguration,
  handled: ReadonlySet<string> = new Set(),
): ValidationResult {
  const errors: ValidationError[] = [];
  const keys = new Set<string>();
  const kindsById = new Map<string, Set<string>>();

  for (const { resource } of effective.resources) {
    keys.add(refKey(resource));
    const kinds = kindsById.get(resource.id) ?? new Set<string>();
    kinds.add(resource.kind);
    kindsById.set(resource.id, kinds);
  }

  for (const [id, kinds] of kindsById) {
    if (kinds.size > 1) {
      errors.push({
        path: id,
        message: `Identyfikator jest uzyty przez kilka rodzajow zasobow: ${[...kinds].sort().join(', ')}.`,
      });
    }
  }

  const engine = effective.profile.engine;
  for (const { resource } of effective.resources) {
    const key = refKey(resource);
    for (const dependency of dependenciesOf(resource)) {
      const dependencyKey = refKey(dependency);
      if (!keys.has(dependencyKey) && !handled.has(dependencyKey)) {
        errors.push({
          path: `${key}.dependencies`,
          message: `Brakuje zaleznosci ${dependencyKey}.`,
        });
      }
    }
    if (
      resource.kind === 'skill' &&
      resource.engines.length > 0 &&
      !resource.engines.includes(engine)
    ) {
      errors.push({
        path: key,
        message: `Skill nie wspiera silnika ${engine} (wspiera: ${resource.engines.join(', ')}).`,
      });
    }
    if (resource.kind === 'mcp') {
      for (const [name, entry] of Object.entries(resource.env)) {
        if ('literal' in entry) {
          errors.push({
            path: `${key}.env.${name}`,
            message:
              'Zmienna ma wartosc wpisana wprost. Uzyj envRef z nazwa zmiennej srodowiskowej.',
          });
        }
      }
      if (resource.args.some((arg) => INLINE_SECRET_ARG.test(arg) || URL_USERINFO.test(arg))) {
        errors.push({
          path: `${key}.args`,
          message:
            'Argument wyglada na sekret podany wprost (np. --token=... albo user:haslo@host). Przekaz go przez envRef.',
        });
      }
    }
  }

  return errors.length > 0 ? fail(errors) : { ok: true };
}
