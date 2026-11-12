import type { Command } from 'commander';

import { validateGlobalConfig } from '../../core/cwm';
import {
  defaultGlobalConfig,
  ensureScopedDirectory,
  homeDirectories,
  homeScope,
  lstatLoose,
  toYaml,
  writeScopedFile,
} from '../../infra/cwm';
import { contextOf, failure, print, printJson } from '../context';

export function registerInit(program: Command): void {
  program
    .command('init')
    .description(
      'Tworzy katalog danych CWM (~/.cwm albo CWM_HOME); istniejacych plikow nie zmienia',
    )
    .action(async (_options: unknown, command: Command) => {
      const { layout, json } = contextOf(command);
      const scope = homeScope(layout.home);
      const created: string[] = [];
      const existing: string[] = [];

      for (const dir of homeDirectories(layout)) {
        const present = (await lstatLoose(dir)) !== null;
        await ensureScopedDirectory(scope, dir);
        (present ? existing : created).push(dir);
      }

      const config = defaultGlobalConfig();
      const check = validateGlobalConfig(config);
      if (!check.ok) throw failure('Domyslna konfiguracja globalna nie przechodzi walidacji.');
      if ((await lstatLoose(layout.configFile)) === null) {
        await writeScopedFile(scope, layout.configFile, toYaml(config));
        created.push(layout.configFile);
      } else {
        existing.push(layout.configFile);
      }

      if (json) return printJson({ ok: true, home: layout.home, created, existing });
      print(`Katalog danych: ${layout.home}`);
      print(created.length === 0 ? 'Nic nowego do utworzenia.' : `Utworzono (${created.length}):`);
      for (const path of created) print(`  ${path}`);
      if (existing.length > 0) print(`Istnialo juz: ${existing.length} pozycji, bez zmian.`);
    });
}
