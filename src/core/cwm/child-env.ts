import { ENV_NAME_PATTERN, nameLooksSecret, valueHasSecretShape } from './env-policy';
import { isPathInside } from '../model/path-containment';
import { CWM_OWNED_ENV } from './patterns';

/**
 * Nazwy, ktore wzorzec sekretu lapie przez przypadek (`PAT` w `PATH`, `SESSION` w identyfikatorze
 * terminala, `CERT` w sciezce do pakietu CA). Dziedziczone bez zmian: to sciezki i identyfikatory.
 */
const BENIGN_SECRET_LOOKALIKES =
  /PATH$|^(?:PWD|OLDPWD|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|TERM_SESSION_ID|SECURITYSESSIONID|DBUS_SESSION_BUS_ADDRESS|SESSION_MANAGER)$|^XDG_SESSION_|SESSION_(?:ID|UUID)$|_SHELL_SESSION$/i;

/** Rodziny zmiennych silnika: z rodzica wchodza tylko przez jawna liste firmy (SPN-02 pkt 3). */
const ENGINE_FAMILY = /^(?:ANTHROPIC_|CLAUDE_)|^CLAUDECODE$/;

export interface ChildEnvInput {
  /** Srodowisko procesu CWM. Nie jest modyfikowane. */
  readonly parent: Readonly<Record<string, string | undefined>>;
  readonly configDir: string;
  readonly tmpDir: string;
  /** Nazwy `envRef` zasobow tej firmy w biezacym uruchomieniu (MCP i Settings). */
  readonly ownRefs: readonly string[];
  /** Nazwy `envRef` zasobow innych firm znane z rejestru. */
  readonly otherCompanyRefs: readonly string[];
  /** `runtime.env.passthrough` firmy: nazwy dziedziczone mimo wzorca sekretu lub rodziny silnika. */
  readonly passthrough: readonly string[];
  /** `Settings.env` z `envRef`: nazwa w silniku -> nazwa zmiennej u uzytkownika (SET-02). */
  readonly settingsEnvRefs: Readonly<Record<string, string>>;
  /** Katalog projektu: elementy `PATH` w nim sa usuwane (uruchomilyby plik z repozytorium). */
  readonly projectDir?: string;
}

export interface ChildEnv {
  readonly env: Record<string, string>;
  /** Nazwy, nigdy wartosci. Posortowane. */
  readonly removed: readonly string[];
  readonly added: readonly string[];
  /** Zmienne, ktorych wartosc miala ksztalt sekretu (prefiks dostawcy, adres z haslem). Tylko nazwy. */
  readonly secretShaped: readonly string[];
  /** Zmienne `envRef`, ktorych brak lub ktore sa puste w srodowisku rodzica. */
  readonly missing: readonly string[];
  /** Wlasne `envRef` o nazwie z rodziny silnika, ktorej lista firmy nie dopuszcza. */
  readonly reserved: readonly string[];
}

/**
 * Tylko bezwzgledne, niepuste elementy bez powtorzen i bez elementow w katalogu projektu. Wzgledny
 * lub projektowy element uruchomilby `./claude` albo narzedzie podlozone w repozytorium.
 */
export function sanitizePath(path: string | undefined, projectDir?: string): string {
  const kept: string[] = [];
  for (const entry of (path ?? '').split(':')) {
    if (!entry.startsWith('/') || kept.includes(entry)) continue;
    if (projectDir !== undefined && isPathInside(entry, projectDir, { allowSame: true })) continue;
    kept.push(entry);
  }
  return kept.length > 0 ? kept.join(':') : '/usr/bin:/bin';
}

/**
 * `envRef` innych firm (SPN-02 pkt 1, SEC-03): wszystkie `envRef` z rejestru, ktore nie naleza do
 * zasobow tej firmy w tym uruchomieniu. Obejmuje zasoby wlaczone przez manifesty innych firm i te,
 * ktore nie sa wlaczone nigdzie: zmienna przeznaczona dla zasobu spoza tego uruchomienia nie
 * ma po co trafiac do silnika.
 */
export function foreignEnvRefs(
  registryRefs: readonly string[],
  ownRefs: readonly string[],
): string[] {
  const own = new Set(ownRefs);
  return [...new Set(registryRefs)].filter((ref) => !own.has(ref)).sort();
}

/**
 * Srodowisko procesu silnika (SPN-02 pkt 1-4): dziedziczenie bez sekretow, nie `{...process.env}`.
 * Usuwa `envRef` innych firm, nazwy wygladajace na sekret i rodzine `ANTHROPIC_*`/`CLAUDE_*`,
 * chyba ze naleza do tej firmy lub do jej listy `passthrough`. Wartosci nie opuszczaja funkcji
 * poza zwracanym srodowiskiem.
 */
export function buildChildEnv(input: ChildEnvInput): ChildEnv {
  const own = new Set(input.ownRefs);
  const other = new Set(input.otherCompanyRefs);
  const pass = new Set(input.passthrough.filter((name) => !CWM_OWNED_ENV.has(name)));
  const env: Record<string, string> = {};
  const removed: string[] = [];
  const secretShaped: string[] = [];

  for (const [name, value] of Object.entries(input.parent)) {
    if (value === undefined || name.includes('=') || name === '') continue;
    const passed = pass.has(name);
    const engineFamily = ENGINE_FAMILY.test(name);
    const trusted = own.has(name) || passed;
    const shaped = !trusted && valueHasSecretShape(value);
    if (shaped) secretShaped.push(name);
    const drop =
      shaped ||
      (other.has(name) && !own.has(name) && !passed) ||
      (engineFamily && !passed) ||
      (nameLooksSecret(name) && !BENIGN_SECRET_LOOKALIKES.test(name) && !own.has(name) && !passed);
    if (drop) removed.push(name);
    else env[name] = value;
  }

  const added: string[] = [];
  const set = (name: string, value: string): void => {
    if (env[name] !== value) added.push(name);
    env[name] = value;
  };
  set('PATH', sanitizePath(input.parent['PATH'], input.projectDir));
  set('CLAUDE_CONFIG_DIR', input.configDir);
  set('CLAUDE_CODE_TMPDIR', input.tmpDir);

  const missing = new Set<string>();
  for (const ref of own) {
    const value = input.parent[ref];
    if (value === undefined || value === '') missing.add(ref);
  }
  for (const [name, ref] of Object.entries(input.settingsEnvRefs)) {
    const value = input.parent[ref];
    if (value === undefined || value === '') missing.add(ref);
    else set(name, value);
  }

  const reserved = [...own].filter(
    (name) => (ENGINE_FAMILY.test(name) || !ENV_NAME_PATTERN.test(name)) && !pass.has(name),
  );
  const sort = (list: Iterable<string>): string[] => [...new Set(list)].sort();
  return {
    env,
    removed: sort(removed),
    added: sort(added),
    secretShaped: sort(secretShaped),
    missing: sort(missing),
    reserved: sort(reserved),
  };
}
