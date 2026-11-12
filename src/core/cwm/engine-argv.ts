/**
 * Argumenty procesu silnika (SPN-03 i wyniki V-05, V-06): flagi CWM, potem jedna flaga z jedna
 * wartoscia, potem argumenty uzytkownika. Flagi wielowartosciowe maja forme `--flaga=wartosc`,
 * bo `--mcp-config a.json "prompt"` polyka prompt jako kolejny plik konfiguracji.
 */

/** Flagi zarzadzane przez CWM: w argumentach uzytkownika zawsze blad uzycia. */
export const MANAGED_FLAGS: readonly string[] = [
  '--settings',
  '--mcp-config',
  '--strict-mcp-config',
  '--plugin-dir',
  '--plugin-url',
  '--setting-sources',
  '--bare',
  '--safe-mode',
];

/** Flagi omijajace uprawnienia albo kierujace sesje poza profil CWM; odblokowanie to osobny etap. */
export const REFUSED_FLAGS: readonly string[] = [
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--agents',
  '--debug-file',
  '--file',
  '--desktop',
  '--cloud',
  '--teleport',
  '--remote-control',
  '--environment',
];

/**
 * Podpolecenia i aliasy z `claude --help` 2.1.322 (plus `config` z wczesniejszej listy). `cwm start -- mcp add ...`
 * zapisaloby serwer do profilu bez zatwierdzenia CWM, a `plugins`, `upgrade` czy `kill` to aliasy tych samych polecen.
 */
export const ENGINE_SUBCOMMANDS: readonly string[] = [
  'agents',
  'attach',
  'auth',
  'auto-mode',
  'config',
  'doctor',
  'gateway',
  'import',
  'install',
  'kill',
  'logs',
  'mcp',
  'plugin',
  'plugins',
  'purge',
  'respawn',
  'rm',
  'setup-token',
  'stop',
  'ultrareview',
  'update',
  'upgrade',
];

export type ArgvResult =
  | { readonly ok: true; readonly argv: readonly string[] }
  | { readonly ok: false; readonly errors: readonly string[] };

export interface ArgvInput {
  /** Bezwzgledna sciezka jedynego pliku `--settings`. */
  readonly settingsFile: string;
  readonly mcpConfigFile: string | null;
  readonly pluginDirs: readonly string[];
  readonly strictMcp: boolean;
  /** Argumenty uzytkownika po `--` w `cwm start`. */
  readonly userArgs: readonly string[];
}

function flagName(arg: string): string {
  const eq = arg.indexOf('=');
  return eq === -1 ? arg : arg.slice(0, eq);
}

/** Zwraca powody odmowy; pusta lista znaczy, ze argumenty moga isc do silnika. */
export function checkPassThroughArgs(args: readonly string[]): string[] {
  const errors: string[] = [];
  const add = (message: string): void => void errors.push(message);

  args.forEach((arg, index) => {
    if (arg.includes('\0')) return add(`Argument ${index + 1} zawiera znak NUL.`);
    if (arg === '--') return add('Drugie "--" w argumentach silnika jest niedozwolone.');
    if (!arg.startsWith('-')) return;
    const name = flagName(arg);
    if (MANAGED_FLAGS.includes(name)) {
      const hint = name === '--strict-mcp-config' ? ' Uzyj: cwm start --strict-mcp.' : '';
      return add(`Flaga ${name} jest zarzadzana przez CWM.${hint}`);
    }
    if (REFUSED_FLAGS.includes(name)) return add(`Flaga ${name} jest odrzucona przez cwm start.`);
    if (name === '--permission-mode') {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[index + 1];
      if (value?.toLowerCase() === 'bypasspermissions') {
        add('Tryb uprawnien bypassPermissions jest odrzucony przez cwm start.');
      }
    }
  });

  // Kazdy argument pozycyjny, nie tylko pierwszy: `--model x mcp add` ma `mcp` jako podpolecenie,
  // a CWM nie wie, ktore opcje biora wartosc.
  const subcommands = new Set(
    args.filter((arg) => !arg.startsWith('-') && ENGINE_SUBCOMMANDS.includes(arg)),
  );
  for (const name of subcommands) {
    add(`Podpolecenie silnika "${name}" nie jest dozwolone w cwm start.`);
  }
  return errors;
}

export function buildEngineArgv(input: ArgvInput): ArgvResult {
  const errors = checkPassThroughArgs(input.userArgs);
  if (errors.length > 0) return { ok: false, errors };

  const argv: string[] = [];
  for (const dir of input.pluginDirs) argv.push(`--plugin-dir=${dir}`);
  if (input.mcpConfigFile !== null) argv.push(`--mcp-config=${input.mcpConfigFile}`);
  if (input.strictMcp) argv.push('--strict-mcp-config');
  argv.push('--settings', input.settingsFile);
  // `--` tylko przed samym promptem: po nim `-p` albo `--model` stalyby sie tekstem promptu.
  const promptOnly =
    input.userArgs.length > 0 && input.userArgs.every((arg) => !arg.startsWith('-'));
  if (promptOnly) argv.push('--');
  argv.push(...input.userArgs);
  return { ok: true, argv };
}
