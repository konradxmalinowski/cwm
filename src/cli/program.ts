import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Command } from 'commander';

import { registerCompany } from './commands/company';
import { registerDoctor } from './commands/doctor';
import { registerImport } from './commands/import';
import { registerInit } from './commands/init';
import { registerProject } from './commands/project';
import { registerResolve } from './commands/resolve';
import { registerResource } from './commands/resource';

function packageVersion(): string {
  try {
    const raw = readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'nieznana';
  } catch {
    return 'nieznana';
  }
}

export function buildProgram(): Command {
  const program = new Command('cwm');
  program
    .description(
      'CWM: zarzadzanie konfiguracja firm i projektow (fundament, bez uruchamiania silnika)',
    )
    .version(packageVersion(), '-V, --version', 'wypisuje wersje')
    .helpOption('-h, --help', 'wypisuje pomoc')
    .option('--json', 'wynik w formacie JSON (bez pytan interaktywnych)')
    .option('--no-input', 'nie pytaj interaktywnie, brakujace wartosci to blad uzycia')
    .showHelpAfterError()
    .exitOverride();

  registerInit(program);
  registerCompany(program);
  registerProject(program);
  registerResource(program);
  registerResolve(program);
  registerImport(program);
  registerDoctor(program);
  return program;
}
