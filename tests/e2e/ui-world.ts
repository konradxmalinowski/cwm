import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Page } from '@playwright/test';
import Database from 'better-sqlite3';

import type { ExportApplyDto, ExportPlanDto } from '../../src/shared/ipc/export-contract';
import type { ImportScanDto } from '../../src/shared/ipc/import-contract';
import type { LibraryListDto } from '../../src/shared/ipc/library-contract';
import { createTempTree } from '../harness/isolation';
import { launchAppWithHome, type LaunchedApp } from './launch';

/**
 * Swiaty testowe interfejsu (Etap 8). Kazdy swiat to syntetyczny HOME i katalog danych w drzewie
 * tymczasowym; zaden nie dotyka prawdziwej konfiguracji (harness odmawia, gdyby tak bylo).
 * Dane powstaja prawdziwymi kanalami IPC, nie zapisem na dysk obok aplikacji, wiec stan, ktory
 * widzi interfejs, jest stanem, ktory aplikacja sama utworzyla.
 */

export type WorldName = 'empty' | 'seeded' | 'rebuilt' | 'refused';

export interface World extends LaunchedApp {
  readonly home: string;
  readonly name: WorldName;
  /** Id elementow po slugu; pusta mapa dla swiata bez biblioteki. */
  readonly items: ReadonlyMap<string, string>;
}

/** Wywolanie kanalu przez most z kontekstu strony, tak jak robi to renderer. */
export async function call<T>(
  page: Page,
  namespace: string,
  method: string,
  payload?: unknown,
): Promise<T> {
  const result = await page.evaluate(
    async ({ ns, fn, body }) => {
      const bridge = (globalThis as unknown as Record<string, Record<string, unknown>>)['uasm'];
      const target = bridge?.[ns] as Record<string, (p?: unknown) => Promise<unknown>> | undefined;
      const handler = target?.[fn];
      if (handler === undefined) throw new Error(`brak kanalu ${ns}.${fn}`);
      return handler(body);
    },
    { ns: namespace, fn: method, body: payload },
  );
  const typed = result as { ok: boolean; value?: T; error?: { message: string } };
  if (!typed.ok) throw new Error(`${namespace}.${method}: ${typed.error?.message ?? 'blad'}`);
  return typed.value as T;
}

/** Dlugie wartosci, ktore interfejs musi zlamac albo skrocic z pelna wartoscia dostepna. */
/** Najdluzsze wartosci, jakie przyjmuje walidacja (64 znaki): slug bez spacji i tytul bez spacji. */
export const LONG_SLUG = 'acme-bardzo-dlugi-slug-elementu-sprawdzajacy-lamanie-wierszy-ab'; // 64 znaki
export const LONG_TITLE = 'Acme_element_z_bardzo_dlugim_tytulem_bez_spacji_lamanie_wierszy_x'; // 64 znaki

/** Plik w Codeksie, ktory test zmienia na dysku, zeby powstal stan zmiany po stronie narzedzia. */
export const TOOL_CHANGED_FILE = 'agents/acme-reviewer.toml';

async function importFromClaude(page: Page): Promise<void> {
  const detect = await call<{ roots: { rootId: string; tool: string; exists: boolean }[] }>(
    page,
    'import',
    'detect',
  );
  const rootIds = detect.roots
    .filter((r) => r.tool === 'claude-code' && r.exists)
    .map((r) => r.rootId);
  const scan = await call<ImportScanDto>(page, 'import', 'scan', { rootIds });
  const picked = scan.candidates
    .filter((c) => c.selectedByDefault && c.secrets.length === 0)
    .map((c) => c.candidateId);
  await call(page, 'import', 'apply', { scanToken: scan.scanToken, candidateIds: picked });
}

async function exportToCodex(page: Page, itemIds: string[]): Promise<ExportApplyDto> {
  const plan = await call<ExportPlanDto>(page, 'export', 'plan', { tool: 'codex', itemIds });
  return call<ExportApplyDto>(page, 'export', 'apply', { planId: plan.planId, approved: true });
}

async function buildSeeded(page: Page, home: string): Promise<Map<string, string>> {
  await importFromClaude(page);
  const created = await call<{ item: { id: string } }>(page, 'library', 'save', {
    draft: {
      kind: 'agent',
      slug: LONG_SLUG,
      title: LONG_TITLE,
      description:
        'Opis tak długi, że w tabeli biblioteki nie zmieści się w jednym wierszu i musi mieć pełną wartość dostępną w podpowiedzi albo w widoku elementu. '.repeat(
          2,
        ),
      body: 'Treść elementu z długim slugiem.\n',
    },
  });

  const list = await call<LibraryListDto>(page, 'library', 'list', {});
  const items = new Map(list.items.map((item) => [item.slug, item.id]));
  items.set(LONG_SLUG, created.item.id);

  // Pierwszy zapis do Codeksa: kazdy z trzech elementow dostaje stan synchronizacji i wpis w historii.
  const agents = ['acme-reviewer', 'acme-bare', 'acme-extra']
    .map((slug) => items.get(slug))
    .filter((id): id is string => id !== undefined);
  if (agents.length < 3) {
    throw new Error(`fixture nie dal oczekiwanych agentow: ${[...items.keys()].join(', ')}`);
  }
  await exportToCodex(page, agents);

  const reviewerId = items.get('acme-reviewer') as string;
  const bareId = items.get('acme-bare') as string;
  const extraId = items.get('acme-extra') as string;

  // Zmiana w bibliotece (acme-bare) i po obu stronach (acme-reviewer): stan "zmieniony w bibliotece"
  // oraz "konflikt", czyli oba wymagajace podgladu roznicy.
  for (const id of [reviewerId, bareId]) {
    const detail = await call<{
      kind: 'agent';
      identity: { slug: string };
      content: { title: string; description: string; body: string };
      scope: 'private';
    }>(page, 'library', 'get', { id });
    await call(page, 'library', 'save', {
      id,
      draft: {
        kind: detail.kind,
        slug: detail.identity.slug,
        title: detail.content.title,
        description: detail.content.description,
        body: `${detail.content.body}\nZmiana w bibliotece (E2E).\n`,
        scope: detail.scope,
      },
    });
  }
  const reviewerFile = join(home, '.codex', TOOL_CHANGED_FILE);
  writeFileSync(
    reviewerFile,
    `${readFileSync(reviewerFile, 'utf8')}\n# zmiana po stronie narzedzia (E2E)\n`,
    'utf8',
  );
  // acme-extra zmieniony tylko po stronie narzedzia.
  const extraFile = join(home, '.codex', 'agents', 'acme-extra.toml');
  if (existsSync(extraFile)) {
    writeFileSync(
      extraFile,
      `${readFileSync(extraFile, 'utf8')}\n# zmiana po stronie narzedzia (E2E)\n`,
      'utf8',
    );
  }
  void extraId;
  return items;
}

function prepareHome(): string {
  const home = createTempTree('acme-home-');
  cpSync('tests/fixtures/claude-code/home', home, { recursive: true });
  cpSync('tests/fixtures/codex/home', home, { recursive: true });
  return home;
}

/** Indeks zapisany przez "nowsza wersje aplikacji": odmowa startu (ADR 0029). */
function writeFutureIndex(userData: string): void {
  const db = new Database(join(userData, 'index.db'));
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
    99,
    new Date().toISOString(),
  );
  db.close();
}

export async function startWorld(name: WorldName): Promise<World> {
  const userData = createTempTree('acme-userdata-');

  if (name === 'empty') {
    const home = createTempTree('acme-home-');
    const launched = await launchAppWithHome(home, userData);
    return { ...launched, home, name, items: new Map() };
  }

  if (name === 'seeded') {
    const home = prepareHome();
    const launched = await launchAppWithHome(home, userData);
    const items = await buildSeeded(launched.page, home);
    return { ...launched, home, name, items };
  }

  const home = createTempTree('acme-home-');
  if (name === 'rebuilt') {
    // Pierwszy start tworzy element, potem indeks przestaje byc baza SQLite.
    const first = await launchAppWithHome(home, userData);
    await call(first.page, 'library', 'save', {
      draft: {
        kind: 'skill',
        slug: 'acme-do-odbudowy',
        title: 'Acme element do odbudowy',
        description: 'Element, który przetrwa odbudowę indeksu.',
        body: 'Treść.\n',
      },
    });
    await first.app.close();
    for (const entry of readdirSync(userData)) {
      if (entry.startsWith('index.db-')) rmSync(join(userData, entry), { force: true });
    }
    writeFileSync(join(userData, 'index.db'), 'to nie jest baza sqlite', 'utf8');
  } else {
    rmSync(join(userData, 'index.db'), { force: true });
    writeFutureIndex(userData);
  }
  const launched = await launchAppWithHome(home, userData);
  return { ...launched, home, name, items: new Map() };
}
