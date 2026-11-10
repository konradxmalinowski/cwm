import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ESLint } from 'eslint';

/**
 * Dowod, ze reguly granic warstw faktycznie blokuja. Skrypt wstawia celowo
 * zakazany import, uruchamia lint, sprawdza, ze padl na oczekiwanej regule,
 * i usuwa plik. Na koniec jedna proba kontrolna: czysty plik w tym samym
 * katalogu musi przejsc, zeby test nie "przechodzil" przez to, ze lint pada
 * zawsze i na wszystko.
 */

const PROBE = '__boundary-probe.ts';

const cases = [
  {
    label: 'core/ importuje electron',
    file: `src/core/${PROBE}`,
    code: "import { app } from 'electron';\n\nexport const probe = app;\n",
    expect: 'no-restricted-imports',
  },
  {
    label: 'core/ importuje node:fs',
    file: `src/core/${PROBE}`,
    code: "import { readFileSync } from 'node:fs';\n\nexport const probe = readFileSync;\n",
    expect: 'no-restricted-imports',
  },
  {
    label: 'core/ importuje better-sqlite3',
    file: `src/core/${PROBE}`,
    code: "import Database from 'better-sqlite3';\n\nexport const probe = Database;\n",
    expect: 'no-restricted-imports',
  },
  {
    label: 'core/ importuje Angulara',
    file: `src/core/${PROBE}`,
    code: "import { Component } from '@angular/core';\n\nexport const probe = Component;\n",
    expect: 'no-restricted-imports',
  },
  {
    label: 'core/ importuje z infra/',
    file: `src/core/${PROBE}`,
    code: "import { SqliteIndexStore } from '../infra/db/index-store';\n\nexport const probe = SqliteIndexStore;\n",
    expect: 'import-x/no-restricted-paths',
  },
  {
    label: 'adapters/ importuje node:fs',
    file: `src/adapters/${PROBE}`,
    code: "import { readFileSync } from 'node:fs';\n\nexport const probe = readFileSync;\n",
    expect: 'no-restricted-imports',
  },
  {
    label: 'adapters/ importuje node:child_process',
    file: `src/adapters/${PROBE}`,
    code: "import { spawnSync } from 'node:child_process';\n\nexport const probe = spawnSync;\n",
    expect: 'no-restricted-imports',
  },
  // Zakaz wykonania (ARCHITECTURE 12.4): kazda droga zaladowania modulu procesow albo `vm`.
  {
    label: 'core/ importuje node:child_process',
    file: `src/core/services/${PROBE}`,
    code: "import { execFile } from 'node:child_process';\n\nexport const probe = execFile;\n",
    expect: 'no-restricted-imports',
  },
  {
    label: 'adapters/ laduje child_process przez require',
    file: `src/adapters/shared/${PROBE}`,
    code: "export const probe: unknown = require('child_process');\n",
    expect: 'no-restricted-syntax',
  },
  {
    label: 'core/ laduje node:child_process dynamicznym importem',
    file: `src/core/${PROBE}`,
    code: "export const probe = import('node:child_process');\n",
    expect: 'no-restricted-syntax',
  },
  {
    label: 'adapters/ importuje node:vm',
    file: `src/adapters/codex/${PROBE}`,
    code: "import { runInNewContext } from 'node:vm';\n\nexport const probe = runInNewContext;\n",
    expect: 'no-restricted-imports',
  },
  {
    label: 'adapters/ importuje worker_threads',
    file: `src/adapters/${PROBE}`,
    code: "import { Worker } from 'worker_threads';\n\nexport const probe = Worker;\n",
    expect: 'no-restricted-imports',
  },
  {
    label: 'adapters/ buduje funkcje z tekstu (new Function)',
    file: `src/adapters/${PROBE}`,
    code: "export const probe = new Function('return 1');\n",
    expect: 'no-restricted-syntax',
  },
  {
    label: 'adapters/ laduje fs przez require (selektor fs nie zginal po bloku wykonania)',
    file: `src/adapters/${PROBE}`,
    code: "export const probe: unknown = require('node:fs');\n",
    expect: 'no-restricted-syntax',
  },
  {
    label: 'renderer importuje z main/',
    file: `src/renderer/${PROBE}`,
    code: "import { IpcRegistry } from '../main/ipc/registry';\n\nexport const probe = IpcRegistry;\n",
    expect: 'import-x/no-restricted-paths',
  },
  // Zapis tylko przez bramke (ADR 0012, Etap 5 kryterium 1): proby poza dozwolona lista.
  {
    label: 'core/ zapisuje do pliku (writeFile)',
    file: `src/core/services/${PROBE}`,
    code: "import { writeFile } from 'node:fs/promises';\n\nexport const probe = writeFile;\n",
    expect: 'no-restricted-imports',
  },
  {
    label: 'handler IPC w main/ zapisuje do pliku (writeFile)',
    file: `src/main/ipc/handlers/${PROBE}`,
    code: "import { writeFile } from 'node:fs/promises';\n\nexport const probe = writeFile;\n",
    expect: 'no-restricted-imports',
  },
  {
    label: 'main/ tworzy katalog synchronicznie (mkdirSync)',
    file: `src/main/bootstrap/${PROBE}`,
    code: "import { mkdirSync } from 'node:fs';\n\nexport const probe = mkdirSync;\n",
    expect: 'no-restricted-imports',
  },
  {
    label: 'infra/fs/ poza lista zapisuje (rename)',
    file: `src/infra/fs/${PROBE}`,
    code: "import { rename } from 'node:fs/promises';\n\nexport const probe = rename;\n",
    expect: 'no-restricted-imports',
  },
  {
    label: 'infra/source/ otwiera uchwyt (open)',
    file: `src/infra/source/${PROBE}`,
    code: "import { open } from 'node:fs/promises';\n\nexport const probe = open;\n",
    expect: 'no-restricted-imports',
  },
  {
    label: 'main/ importuje przestrzen nazw fs (omiecie listy aliasem)',
    file: `src/main/${PROBE}`,
    code: "import * as fs from 'node:fs';\n\nexport const probe = fs;\n",
    expect: 'no-restricted-imports',
  },
  {
    label: 'main/ importuje domyslny eksport fs',
    file: `src/main/${PROBE}`,
    code: "import fs from 'node:fs';\n\nexport const probe = fs;\n",
    expect: 'no-restricted-imports',
  },
  {
    label: 'main/ laduje fs przez require',
    file: `src/main/${PROBE}`,
    code: "export const probe = require('node:fs');\n",
    expect: 'no-restricted-syntax',
  },
  {
    label: 'main/ laduje fs/promises dynamicznym importem',
    file: `src/main/${PROBE}`,
    code: "export const probe = import('node:fs/promises');\n",
    expect: 'no-restricted-syntax',
  },
];

// Proby pozytywne: lint nie moze zglosic niczego. Dowodza, ze regula zapisu jest wasko
// ograniczona do listy, a nie wylacza ani nie zabija kodu, ktory ma prawo zapisywac.
const passCases = [
  {
    label: 'dozwolone: infra/library/ zapisuje',
    file: `src/infra/library/${PROBE}`,
    code: "import { writeFile, mkdir } from 'node:fs/promises';\n\nexport const probe = [writeFile, mkdir];\n",
  },
  {
    label: 'dozwolone: infra/store/ zapisuje',
    file: `src/infra/store/${PROBE}`,
    code: "import { rm } from 'node:fs/promises';\n\nexport const probe = rm;\n",
  },
  {
    label: 'dozwolone: infra/logging/ zapisuje',
    file: `src/infra/logging/${PROBE}`,
    code: "import { appendFileSync } from 'node:fs';\n\nexport const probe = appendFileSync;\n",
  },
  {
    label: 'dozwolone: infra/db/ zapisuje',
    file: `src/infra/db/${PROBE}`,
    code: "import { renameSync } from 'node:fs';\n\nexport const probe = renameSync;\n",
  },
  {
    label: 'dozwolone: infra/ moze uruchamiac procesy (granica dotyczy core/ i adapters/)',
    file: `src/infra/platform/${PROBE}`,
    code: "import { execFile } from 'node:child_process';\n\nexport const probe = execFile;\n",
  },
  {
    label: 'dozwolone: adapters/ uzywa slowa Function w nazwie typu i tekscie',
    file: `src/adapters/${PROBE}`,
    code: "export type FunctionLike = () => void;\nexport const probe = 'new Function';\n",
  },
  {
    label: 'odczyt z main/ nie jest zapisem (readFile, stat)',
    file: `src/main/ipc/handlers/${PROBE}`,
    code: "import { readFile, stat } from 'node:fs/promises';\n\nexport const probe = [readFile, stat];\n",
  },
];

const control = {
  label: 'proba kontrolna: czysty plik w core/ przechodzi',
  file: `src/core/${PROBE}`,
  code: 'export const probe = 1;\n',
};

const eslint = new ESLint({ cwd: process.cwd() });
const failures = [];

for (const passCase of passCases) {
  await writeProbe(passCase.file, passCase.code);
  try {
    const rules = await lint(passCase.file);
    if (rules.length === 0) {
      process.stdout.write(`PASS  ${passCase.label}\n`);
    } else {
      failures.push(`${passCase.label}: lint zglosil [${rules.join(', ')}]`);
      process.stdout.write(`FAIL  ${passCase.label} -> [${rules.join(', ')}]\n`);
    }
  } finally {
    await rm(passCase.file, { force: true });
  }
}

// Katalogi warstw moga byc jeszcze puste (git nie sledzi pustych katalogow),
// a proba granicy musi dac sie zapisac takze w swiezym klonie.
async function writeProbe(file, code) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, code, 'utf8');
}

async function lint(file) {
  const results = await eslint.lintFiles([file]);
  return results.flatMap((result) => result.messages.map((message) => message.ruleId ?? 'parse'));
}

for (const testCase of cases) {
  await writeProbe(testCase.file, testCase.code);
  try {
    const rules = await lint(testCase.file);
    if (rules.includes(testCase.expect)) {
      process.stdout.write(`PASS  ${testCase.label} -> ${testCase.expect}\n`);
    } else {
      failures.push(
        `${testCase.label}: oczekiwano ${testCase.expect}, dostano [${rules.join(', ')}]`,
      );
      process.stdout.write(`FAIL  ${testCase.label} -> [${rules.join(', ')}]\n`);
    }
  } finally {
    await rm(testCase.file, { force: true });
  }
}

await writeProbe(control.file, control.code);
try {
  const rules = await lint(control.file);
  if (rules.length === 0) {
    process.stdout.write(`PASS  ${control.label}\n`);
  } else {
    failures.push(`${control.label}: lint zglosil [${rules.join(', ')}]`);
    process.stdout.write(`FAIL  ${control.label} -> [${rules.join(', ')}]\n`);
  }
} finally {
  await rm(control.file, { force: true });
}

if (failures.length > 0) {
  process.stderr.write(`\nreguly granic nie dzialaja:\n- ${failures.join('\n- ')}\n`);
  process.exit(1);
}

process.stdout.write(
  `\nwszystkie ${cases.length + passCases.length + 1} proby granic zachowaly sie zgodnie z oczekiwaniem\n`,
);
