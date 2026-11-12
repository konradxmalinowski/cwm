import js from '@eslint/js';
import importX from 'eslint-plugin-import-x';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Granice warstw sa tu regula lintu, nie dobra wola (ROADMAP sekcja 1).
 * Dwa mechanizmy, bo pilnuja dwoch roznych rzeczy:
 *
 * - `no-restricted-imports` per katalog pilnuje pakietow: `core/` nie widzi
 *   Electrona, systemu plikow, sterownika bazy ani Angulara.
 * - `import-x/no-restricted-paths` pilnuje kierunku zaleznosci miedzy
 *   katalogami, niezaleznie od tego, jak zapisano sciezke importu.
 *
 * Dowod, ze reguly faktycznie blokuja, jest w `scripts/verify-boundaries.mjs`
 * i w zadaniu `boundaries` w CI. Regula bez takiego dowodu nie jest regula.
 */

const FS_MODULES = ['fs', 'node:fs', 'fs/promises', 'node:fs/promises'];
const PROCESS_MODULES = ['child_process', 'node:child_process'];
/**
 * Wykonanie kodu poza procesami (ARCHITECTURE 12.4 "zakaz wykonania", ADR 0008): core/ i adapters/
 * dotykaja niezaufanej tresci z importu, wiec nie maja ani procesow, ani watkow, ani `vm`.
 */
const EXEC_MODULES = [
  ...PROCESS_MODULES,
  'worker_threads',
  'node:worker_threads',
  'vm',
  'node:vm',
  'cluster',
  'node:cluster',
];
const EXEC_PATTERN = '^(node:)?(child_process|worker_threads|vm|cluster)$';

/**
 * Funkcje zapisujace i zmieniajace system plikow (ADR 0012, ROADMAP Etap 5 kryterium 1).
 * `open`/`openSync` sa na liscie, bo uchwyt otwarty do zapisu omija reszte. `promises` i import
 * przestrzeni nazw (`* as fs`) tez lapie regula, zeby nie dalo sie obejsc listy aliasem.
 */
const FS_WRITE_NAMES = [
  'default',
  'promises',
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'rename',
  'renameSync',
  'unlink',
  'unlinkSync',
  'rm',
  'rmSync',
  'rmdir',
  'rmdirSync',
  'symlink',
  'symlinkSync',
  'link',
  'linkSync',
  'mkdir',
  'mkdirSync',
  'mkdtemp',
  'mkdtempSync',
  'chmod',
  'chmodSync',
  'lchmod',
  'lchmodSync',
  'chown',
  'chownSync',
  'lchown',
  'lchownSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'truncate',
  'truncateSync',
  'utimes',
  'utimesSync',
  'lutimes',
  'lutimesSync',
  'open',
  'openSync',
  'createWriteStream',
  'write',
  'writeSync',
  'writev',
  'writevSync',
  'opendir',
];

/**
 * Dozwolona lista miejsc zapisu, wynik inwentaryzacji grepem po `src/` (Etap 5). Kazdy wpis ma
 * powod. Plik spoza listy, ktory potrzebuje zapisu, idzie przez `WriteGate` albo trafia tu
 * z uzasadnieniem w przegladzie; regula nie jest wylaczana komentarzem nigdzie.
 */
const FS_WRITE_ALLOWED = [
  // Prymityw zapisu atomowego, z ktorego korzysta WriteGate (ADR 0031).
  'src/infra/fs/atomic.ts',
  // Sama bramka zapisu (ADR 0012): mkdir/rm/rmdir przy materializacji i rollbacku.
  'src/infra/fs/write-gate.ts',
  // Wykrywanie zdolnosci dowiazan: probne symlink/link w katalogu tymczasowym.
  'src/infra/fs/link-mode.ts',
  // Odczyt z limitem rozmiaru. Uzywa `open` wylacznie z O_RDONLY, ale `open` jest na liscie
  // zakazanych, bo uchwyt do zapisu omijalby bramke.
  'src/infra/fs/bounded-read.ts',
  // Wlasna biblioteka uzytkownika w userData (ADR 0014), poza konfiguracja narzedzi.
  'src/infra/library/**',
  // Content store i backupy w userData (ADR 0019).
  'src/infra/store/**',
  // Zapis CLI (`cwm`) do ~/.cwm i <projekt>/.cwm: mkdir/chmod z trybami 700, odmowa poza dwoma
  // korzeniami i dla .claude, CLAUDE.md, .mcp.json. Pliki ida przez atomic.ts (temp + rename).
  'src/infra/cwm/writer.ts',
  // Odczyt katalogow CWM iteratorem `opendir` z limitem wpisow (bez pelnego readdir). Tylko odczyt;
  // `opendir` jest na liscie zakazanych, bo ta lista nie odroznia odczytu od zapisu.
  'src/infra/cwm/read.ts',
  // Kwarantanna uszkodzonego indeksu (ADR 0029) i tworzenie katalogu bazy.
  'src/infra/db/**',
  // Logger do userData/logs/app.log (ADR 0014).
  'src/infra/logging/**',
  // Testy buduja i sprzataja drzewa tymczasowe; izolacja jest pilnowana przez harness.
  'tests/**',
  // Skrypty deweloperskie i buildowe nie sa czescia aplikacji.
  'scripts/**',
];

const FS_MODULE_NAMES = ['fs', 'node:fs', 'fs/promises', 'node:fs/promises'];
const FS_WRITE_MESSAGE =
  'Zapis do systemu plikow tylko przez WriteGate albo z dozwolonej listy (ADR 0012, eslint.config.mjs).';

/** `require` i `import()` omijaja `no-restricted-imports`, wiec maja osobne selektory. */
const FS_DYNAMIC_LOADS = [
  {
    selector: `CallExpression[callee.name='require'][arguments.0.value=/^(node:)?fs(\\/promises)?$/]`,
    message: FS_WRITE_MESSAGE,
  },
  {
    selector: `ImportExpression[source.value=/^(node:)?fs(\\/promises)?$/]`,
    message: FS_WRITE_MESSAGE,
  },
];

const EXEC_MESSAGE =
  'core/ i adapters/ niczego nie wykonuja: importowana tresc jest niezaufana (ARCHITECTURE 12.4, ADR 0008).';
const EXEC_DYNAMIC_LOADS = [
  {
    selector: `CallExpression[callee.name='require'][arguments.0.value=/${EXEC_PATTERN}/]`,
    message: EXEC_MESSAGE,
  },
  { selector: `ImportExpression[source.value=/${EXEC_PATTERN}/]`, message: EXEC_MESSAGE },
];

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'release/**',
      'coverage/**',
      '.angular/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      'tests/fixtures/**',
      'docs/**',
    ],
  },

  js.configs.recommended,

  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    files: ['**/*.{ts,mjs,js}'],
    plugins: { 'import-x': importX },
    settings: {
      'import-x/resolver-next': [
        importX.createNodeResolver({ extensions: ['.ts', '.js', '.mjs', '.json'] }),
      ],
    },
    rules: {
      'no-console': ['error', { allow: ['error', 'warn'] }],
      eqeqeq: ['error', 'always'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'import-x/no-restricted-paths': [
        'error',
        {
          zones: [
            { target: './src/core', from: './src/main' },
            { target: './src/core', from: './src/infra' },
            { target: './src/core', from: './src/adapters' },
            { target: './src/core', from: './src/renderer' },
            { target: './src/core', from: './src/preload' },
            { target: './src/adapters', from: './src/main' },
            { target: './src/adapters', from: './src/infra' },
            { target: './src/adapters', from: './src/renderer' },
            { target: './src/renderer', from: './src/main' },
            { target: './src/renderer', from: './src/infra' },
            { target: './src/renderer', from: './src/adapters' },
            { target: './src/renderer', from: './src/preload' },
            // CLI jest drugim composition rootem: widzi core i infra, nie widzi procesow Electrona.
            { target: './src/cli', from: './src/main' },
            { target: './src/cli', from: './src/renderer' },
            { target: './src/cli', from: './src/preload' },
            { target: './src/core', from: './src/cli' },
            { target: './src/adapters', from: './src/cli' },
            { target: './src/infra', from: './src/cli' },
            { target: './src/main', from: './src/cli' },
            { target: './src/renderer', from: './src/cli' },
          ],
        },
      ],
    },
  },

  // Zapis tylko przez bramke. Blok stoi PRZED blokami per warstwa: te zakazuja fs w calosci
  // i nadpisuja ten, wiec core/, adapters/ i renderer/ nadal widza swoje komunikaty.
  {
    files: ['src/**/*.ts'],
    ignores: FS_WRITE_ALLOWED,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: FS_MODULE_NAMES.map((name) => ({
            name,
            importNames: FS_WRITE_NAMES,
            message: FS_WRITE_MESSAGE,
          })),
        },
      ],
      'no-restricted-syntax': ['error', ...FS_DYNAMIC_LOADS],
    },
  },

  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'electron', message: 'core/ nie zna Electrona (ROADMAP sekcja 1).' },
            {
              name: 'better-sqlite3',
              message: 'core/ nie zna sterownika bazy - uzyj portu IndexStore.',
            },
            ...FS_MODULES.map((name) => ({
              name,
              message: 'core/ nie dotyka systemu plikow - uzyj portu FileGateway.',
            })),
            ...EXEC_MODULES.map((name) => ({
              name,
              message: 'core/ nie uruchamia procesow ani kodu (ADR 0008, ARCHITECTURE 12.4).',
            })),
          ],
          patterns: [
            { group: ['electron/*'], message: 'core/ nie zna Electrona.' },
            { group: ['@angular/*'], message: 'core/ nie zna Angulara (ROADMAP sekcja 1).' },
          ],
        },
      ],
    },
  },

  {
    files: ['src/adapters/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'electron', message: 'adapters/ nie zna Electrona.' },
            ...FS_MODULES.map((name) => ({
              name,
              message: 'adapters/ nie dotyka systemu plikow bezposrednio - uzyj WriteGate.',
            })),
            ...EXEC_MODULES.map((name) => ({
              name,
              message:
                'adapters/ nie uruchamia procesow ani kodu: importowana tresc jest niezaufana (ADR 0008).',
            })),
          ],
          patterns: [{ group: ['electron/*'], message: 'adapters/ nie zna Electrona.' }],
        },
      ],
    },
  },

  // Zakaz wykonania takze przez `require` i `import()`. Blok powtarza selektory fs, bo
  // `no-restricted-syntax` z pozniejszego bloku zastepuje wczesniejszy, a nie dokleja sie do niego.
  {
    files: ['src/core/**/*.ts', 'src/adapters/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...FS_DYNAMIC_LOADS,
        ...EXEC_DYNAMIC_LOADS,
        {
          selector: "NewExpression[callee.name='Function']",
          message: EXEC_MESSAGE,
        },
        {
          selector: "CallExpression[callee.name='Function']",
          message: EXEC_MESSAGE,
        },
      ],
    },
  },

  {
    files: ['src/renderer/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'electron', message: 'renderer nie zna Electrona (ADR 0008).' },
            ...FS_MODULES.map((name) => ({
              name,
              message: 'renderer nie ma dostepu do systemu plikow (ADR 0008).',
            })),
            ...PROCESS_MODULES.map((name) => ({
              name,
              message: 'renderer nie uruchamia procesow (ADR 0008).',
            })),
          ],
          patterns: [{ group: ['electron/*'], message: 'renderer nie zna Electrona (ADR 0008).' }],
        },
      ],
    },
  },

  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/infra/**/*.ts', 'src/cli/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Proces glowny loguje wylacznie przez logger z redakcja (ARCHITECTURE 8.4): zadnego console.*.
  {
    files: ['src/main/**/*.ts'],
    rules: { 'no-console': 'error' },
  },

  {
    files: ['scripts/**/*.mjs', '*.config.mjs'],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'module',
    },
    rules: {
      'no-console': 'off',
    },
  },

  // Skrypty deweloperskie w CommonJS. Jeden z nich jest wstrzykiwany do
  // procesu glownego Electrona przez NODE_OPTIONS, wiec musi byc CJS.
  {
    files: ['scripts/**/*.cjs'],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'commonjs',
    },
    rules: {
      'no-console': 'off',
    },
  },

  {
    files: ['tests/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
