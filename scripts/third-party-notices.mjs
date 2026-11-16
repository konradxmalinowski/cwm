import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * THIRD_PARTY_NOTICES.md z package-lock.json: tylko zaleznosci produkcyjne (bez `dev`), nazwa,
 * wersja, licencja. Wynik jest deterministyczny (sortowanie po nazwie), wiec `--check` w
 * przegladzie zmian pokazuje rozjazd z lockfile. Brak pola `license` to blad, nie "nieznana".
 *
 * Uzycie: node scripts/third-party-notices.mjs [--check]
 */
const root = new URL('../', import.meta.url);
const lockPath = fileURLToPath(new URL('package-lock.json', root));
const outPath = fileURLToPath(new URL('THIRD_PARTY_NOTICES.md', root));
const check = process.argv.includes('--check');

const lock = JSON.parse(await readFile(lockPath, 'utf8'));
const entries = [];
for (const [path, info] of Object.entries(lock.packages ?? {})) {
  if (path === '' || info.dev === true || info.link === true) continue;
  const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
  if (typeof info.license !== 'string' || info.license === '') {
    throw new Error(`Brak licencji w lockfile: ${name}`);
  }
  entries.push({ name, version: info.version, license: info.license });
}
entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const lines = [
  '# Licencje komponentów zewnętrznych',
  '',
  'Plik jest generowany poleceniem `npm run notices` z `package-lock.json`. Nie edytuj go ręcznie.',
  'Własna licencja projektu (MIT) jest w pliku `LICENSE`.',
  '',
  '## Zależności produkcyjne (npm)',
  '',
  ...entries.map((e) => `- \`${e.name}\` ${e.version} - ${e.license}`),
  '',
  '## Czcionki',
  '',
  'Czcionki dołączone do aplikacji mają licencję SIL Open Font License 1.1. Pełne teksty licencji są',
  'w `src/renderer/assets/fonts/LICENSE-*` i trafiają do paczki razem z czcionkami.',
  '',
  '- Commit Mono',
  '- Source Sans 3',
  '- Space Grotesk',
  '',
  '## Electron i Chromium',
  '',
  'Instalatory zawierają Electron (MIT) i Chromium. Ich teksty licencji są dołączone przez Electron',
  'do każdej paczki (`LICENSE.electron.txt`, `LICENSES.chromium.html`).',
  '',
];
const output = lines.join('\n');

if (check) {
  let current = '';
  try {
    current = await readFile(outPath, 'utf8');
  } catch {
    // Brak pliku to rozjazd jak kazdy inny.
  }
  if (current !== output) {
    console.error('THIRD_PARTY_NOTICES.md nie zgadza sie z package-lock.json: npm run notices');
    process.exit(1);
  }
} else {
  await writeFile(outPath, output);
  console.log(`THIRD_PARTY_NOTICES.md: ${String(entries.length)} pakietow`);
}
