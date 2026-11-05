import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

import { createTempTree } from '../harness/isolation';

export interface LaunchedApp {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly userDataDir: string;
}

/**
 * Katalog danych jest przekierowany wbudowanym przelacznikiem Electrona
 * `--user-data-dir`, a nie wlasna zmienna srodowiskowa. Dzieki temu w kodzie
 * aplikacji nie ma ani jednej linii istniejacej tylko dla testow, a przebieg
 * nie dotyka profilu uzytkownika.
 */
/**
 * Limit na sam start zapakowanej binarki, osobny od limitu testu.
 *
 * Hipoteza o koszcie pierwszego uruchomienia niepodpisanego pliku zostala
 * **obalona pomiarem**: 180 s i 300 s daly na runnerze Windows identyczny
 * wynik, a linia z czasem startu nie pojawila sie w logu ani razu, czyli start
 * nie konczyl sie ani szybko, ani wolno - nie konczyl sie wcale. Powtorka
 * zadania na commicie, ktory byl zielony, padla tak samo, wiec nie ma tam
 * regresji, jest niestabilnosc.
 *
 * Skoro wyzszy limit niczego nie kupuje, zostaje nizszy: czerwone zadanie ma
 * kosztowac minuty, nie dziesiec.
 */
const PACKAGED_LAUNCH_TIMEOUT_MS = 120_000;

/**
 * Zmienne, ktore nie maja prawa wejsc do uruchamianej aplikacji.
 *
 * `NODE_OPTIONS` ustawia tryb deweloperski, zeby wstrzyknac obserwator plikow
 * (scripts/dev-reload.cjs). Electron odrzuca je w zapakowanej aplikacji, ale
 * test nie ma dziedziczyc po procesie rodzica czegokolwiek, co wplywa na
 * uruchamiany proces - ma kontrolowac srodowisko, w ktore startuje.
 * `ELECTRON_RUN_AS_NODE` zmienia Electrona w zwykly Node, czyli aplikacja
 * nie wystartowalaby w ogole.
 */
const STRIPPED_ENV_KEYS = ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'] as const;

function launchEnv(overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if ((STRIPPED_ENV_KEYS as readonly string[]).includes(key)) continue;
    env[key] = value;
  }
  env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = '1';
  // Bez tego zawis startu nie zostawia na stderr zadnego sladu, a cisza
  // w logu byla najbardziej kosztowna cecha awarii na Windowsie.
  env['ELECTRON_ENABLE_LOGGING'] = '1';
  return { ...env, ...overrides };
}

/**
 * Limit od przylaczenia do widocznej powloki. Zmierzone lokalnie na macOS w 506
 * startach: caly test z uruchomieniem trwa ponizej 1 s, wiec 30 s to zapas, a nie
 * prog. Limit nie leczy niczego; jego zadaniem jest zamienic cisze do limitu
 * testu na blad z etapem i stderr.
 */
const SHELL_TIMEOUT_MS = 30_000;
const STDERR_TAIL_LINES = 20;

/**
 * Electron, ktory nie zaladowal procesu glownego, nie konczy sie: pokazuje okno
 * bledu i czeka. Sprawdzone na celowo ucietym pliku main - po 8 s proces zyl,
 * a jedynym sladem byla ta linia na stderr.
 */
const MAIN_LOAD_ERROR = 'App threw an error during load';

async function awaitShell(app: ElectronApplication, startedAt: number): Promise<Page> {
  const child = app.process();
  const tail: string[] = [];
  let stage = 'okno';
  let rejectEarly: (error: Error) => void = () => undefined;
  const early = new Promise<never>((_, reject) => {
    rejectEarly = reject;
  });
  early.catch(() => undefined);

  const onStderr = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line === '') continue;
      tail.push(line);
      if (tail.length > STDERR_TAIL_LINES) tail.shift();
      if (line.includes(MAIN_LOAD_ERROR)) rejectEarly(new Error('proces glowny nie zaladowal sie'));
    }
  };
  const onExit = (code: number | null, signal: string | null): void => {
    rejectEarly(new Error(`proces zakonczyl sie przed powloka (kod ${code}, sygnal ${signal})`));
  };
  child.stderr?.on('data', onStderr);
  child.once('exit', onExit);

  try {
    const page = await Promise.race([app.firstWindow({ timeout: SHELL_TIMEOUT_MS }), early]);
    stage = 'powloka renderera';
    await Promise.race([
      page.waitForSelector('[data-testid="app-shell"]', { timeout: SHELL_TIMEOUT_MS }),
      early,
    ]);
    return page;
  } catch (error: unknown) {
    child.kill();
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `start aplikacji utknal na etapie "${stage}" po ${Date.now() - startedAt} ms: ${reason}\n` +
        `ostatnie linie stderr:\n${tail.join('\n') || '(brak)'}`,
      { cause: error },
    );
  } finally {
    child.stderr?.off('data', onStderr);
    child.off('exit', onExit);
  }
}

async function launch(
  args: string[],
  executablePath?: string,
  presetUserDataDir?: string,
  envOverrides?: Readonly<Record<string, string>>,
): Promise<LaunchedApp> {
  const userDataDir = presetUserDataDir ?? createTempTree('acme-userdata-');
  const startedAt = Date.now();

  if (executablePath !== undefined) {
    // Zrzut przed startem, zeby kolejna awaria dawala dane, a nie domysly.
    // Jesli NODE_OPTIONS nie ma w srodowisku, to nie ona jest przyczyna
    // i przestajemy o niej mowic.
    const stripped = STRIPPED_ENV_KEYS.map(
      (key) =>
        `${key}=${process.env[key] === undefined ? 'brak' : JSON.stringify(process.env[key])}`,
    ).join(' ');
    process.stdout.write(
      `[e2e] start paczki na ${process.platform}: ${executablePath}\n` +
        `[e2e] srodowisko rodzica, zmienne usuwane przed startem: ${stripped}\n`,
    );
  }

  const app = await electron.launch({
    args: [...args, `--user-data-dir=${userDataDir}`],
    cwd: process.cwd(),
    // Bez jawnego limitu przylaczenie czeka do limitu testu. Tak wisial start
    // z ucietym plikiem main: "Debugger listening" jest, "DevTools listening" nie.
    timeout: executablePath === undefined ? SHELL_TIMEOUT_MS : PACKAGED_LAUNCH_TIMEOUT_MS,
    // Bez tego Playwright sam dokłada `--no-sandbox` do argumentow Electrona,
    // czyli test hartowania jechalby z wylaczonym sandboxem systemowym
    // i milczalby o tym. Na Linuksie wymaga to pomocnika chrome-sandbox
    // z bitem setuid - jest na to krok w ci.yml.
    chromiumSandbox: true,
    ...(executablePath === undefined ? {} : { executablePath }),
    env: launchEnv(envOverrides),
  });

  const page = await awaitShell(app, startedAt);

  if (executablePath !== undefined) {
    process.stdout.write(`[e2e] paczka wystartowala po ${Date.now() - startedAt} ms\n`);
  }

  return { app, page, userDataDir };
}

/** Uruchamia zbudowana aplikacje z `dist/` (pole `main` w package.json). */
export function launchApp(): Promise<LaunchedApp> {
  return launch(['.']);
}

/**
 * To samo, ale z katalogiem danych przygotowanym przez test - potrzebne tam,
 * gdzie trzeba podstawic zepsuty indeks jeszcze przed startem aplikacji.
 */
export function launchAppWithUserData(userDataDir: string): Promise<LaunchedApp> {
  return launch(['.'], undefined, userDataDir);
}

/**
 * Aplikacja ze skonfigurowanym katalogiem domowym narzedzi: `home` zastepuje HOME i USERPROFILE,
 * a `CLAUDE_CONFIG_DIR` i `CODEX_HOME` wskazuja w niego. Dzieki temu przeplyw z prawdziwymi
 * plikami narzedzi idzie wylacznie po syntetycznym drzewie z harnessu, nigdy po profilu uzytkownika.
 */
export function launchAppWithHome(home: string, userDataDir: string): Promise<LaunchedApp> {
  return launch(['.'], undefined, userDataDir, {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'),
  });
}

const RELEASE_DIR = 'release';

/**
 * Nazwa binarki na Linuksie jest przypieta w `electron-builder.yml`
 * (`linux.executableName`). Zgadywanie "pierwszy plik bez kropki" skonczylo sie
 * tym, ze test uruchomil `chrome-sandbox`, bo sortuje sie wczesniej niz
 * aplikacja - i padl na komunikacie o sandboxie, ktory nie mial nic do rzeczy.
 */
const LINUX_EXECUTABLE = 'universal-ai-skills-manager';
const WINDOWS_EXECUTABLE = 'Universal AI Skills Manager.exe';
const HELPER_BINARIES = new Set(['chrome-sandbox', 'chrome_crashpad_handler', 'crashpad_handler']);

function findInReleaseDir(dir: string): string | null {
  if (process.platform === 'darwin') {
    const bundle = readdirSync(dir).find((name) => name.endsWith('.app'));
    if (bundle === undefined) return null;
    const macOsDir = join(dir, bundle, 'Contents', 'MacOS');
    if (!existsSync(macOsDir)) return null;
    const binary = readdirSync(macOsDir).find((name) => !HELPER_BINARIES.has(name));
    return binary === undefined ? null : join(macOsDir, binary);
  }

  if (process.platform === 'win32') {
    const exact = join(dir, WINDOWS_EXECUTABLE);
    if (existsSync(exact)) return exact;
    const exe = readdirSync(dir).find(
      (name) => name.endsWith('.exe') && !HELPER_BINARIES.has(name),
    );
    return exe === undefined ? null : join(dir, exe);
  }

  const exact = join(dir, LINUX_EXECUTABLE);
  return existsSync(exact) ? exact : null;
}

/**
 * Sciezka do binarki z `electron-builder --dir`.
 *
 * Zwraca `null` tylko wtedy, gdy paczki w ogole nie ma - wtedy testy przeciw
 * zapakowanej aplikacji sa pominiete jawnie. Jesli katalog `release/` istnieje,
 * ale binarki w nim nie ma, leci blad. Rozroznienie jest celowe: cicho
 * pominiety test przeciw paczce dawalby zielona macierz, ktora nic nie
 * sprawdzila.
 */
export function packagedExecutable(): string | null {
  if (!existsSync(RELEASE_DIR)) return null;

  const candidates = readdirSync(RELEASE_DIR, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );
  if (candidates.length === 0) return null;

  for (const entry of candidates) {
    const found = findInReleaseDir(join(RELEASE_DIR, entry.name));
    if (found !== null) return found;
  }

  const expected =
    process.platform === 'darwin'
      ? 'pakiet *.app z binarka w Contents/MacOS'
      : process.platform === 'win32'
        ? WINDOWS_EXECUTABLE
        : LINUX_EXECUTABLE;

  throw new Error(
    `katalog ${RELEASE_DIR}/ istnieje, ale nie ma w nim binarki aplikacji dla ${process.platform}. ` +
      `Szukalem: ${expected}. Jesli nazwa zmienila sie w electron-builder.yml, popraw ja takze ` +
      'w tests/e2e/launch.ts.',
  );
}

export function launchPackagedApp(executablePath: string): Promise<LaunchedApp> {
  return launch([], executablePath);
}
