import { randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { gitRefProblem, gitUrlProblem, sanitizeGitUrl } from '../../core/cwm';
import type { RootId } from '../../core/model/item';
import type {
  GitSourceFailure,
  GitSourceOpen,
  GitSourceProvider,
  GitSourceRequest,
} from '../../core/ports/git-source';
import type { SourceReader } from '../../core/ports/source-reader';
import type { DetectedRoot, RootKind } from '../../core/ports/tool-adapter';
import { SingleSkillReader } from '../../core/services/import/single-skill-reader';
import { abortRunningGit, fetchGitSource, type GitFetchResult } from '../cwm/git-fetch';
import { createLayout, type CwmLayout } from '../cwm/layout';
import {
  ensureScopedDirectory,
  homeScope,
  removeScopedTree,
  secureScopedRoot,
} from '../cwm/writer';
import { FsSourceReader } from '../source/fs-source-reader';

/**
 * Import z repozytorium Git (ADR 0058). Pobieranie, siec i proces `git` to wylacznie `cwm/git-fetch.ts`
 * (te same limity, ten sam straznik sieci, ta sama weryfikacja kopii co przy pluginach z git); ten plik
 * tylko wskazuje mu katalog roboczy pod `userData` zamiast `~/.cwm`, wykrywa uklad kopii i oddaje czytnik
 * tylko do odczytu. Kopia jest niezaufana tresca: nic z niej nie jest wykonywane, a po skanie znika.
 */

interface LayoutRoot {
  readonly tool: DetectedRoot['tool'];
  readonly kind: RootKind;
  readonly segments: readonly string[];
}

/**
 * Uklady, ktore aplikacja rozpoznaje w kopii, w kolejnosci pierwszenstwa przy duplikatach (ADR 0024).
 * Tylko skille, agenci i komendy: instrukcje globalne i hooki z cudzego repozytorium nie wchodza do
 * biblioteki tą droga (ADR 0058). Katalog `skills/` w korzeniu to wspolny uklad repozytoriow ze skillami
 * i skanuje go adapter Claude Code, narzedzie, ktore aplikacja wspiera jako pierwsze.
 */
const LAYOUT: readonly LayoutRoot[] = [
  { tool: 'claude-code', kind: 'skills', segments: ['skills'] },
  { tool: 'claude-code', kind: 'skills', segments: ['.claude', 'skills'] },
  { tool: 'claude-code', kind: 'agents', segments: ['.claude', 'agents'] },
  { tool: 'claude-code', kind: 'commands', segments: ['.claude', 'commands'] },
  { tool: 'codex', kind: 'skills', segments: ['.codex', 'skills'] },
  { tool: 'codex', kind: 'agents', segments: ['.codex', 'agents'] },
  { tool: 'gemini-cli', kind: 'skills', segments: ['.gemini', 'skills'] },
  { tool: 'gemini-cli', kind: 'agents', segments: ['.gemini', 'agents'] },
  { tool: 'gemini-cli', kind: 'commands', segments: ['.gemini', 'commands'] },
];

export const SINGLE_SKILL_LABEL = '(korzeń repozytorium)';

export const GIT_UNAVAILABLE_MESSAGE =
  'Import z repozytorium Git wymaga programu git. Nie znaleziono go w PATH (albo działa na tym systemie inaczej niż zakłada aplikacja). Zainstaluj git i uruchom CWM ponownie. Reszta aplikacji działa bez niego.';
export const GIT_FETCH_FAILED_MESSAGE =
  'Nie udało się pobrać repozytorium. Sprawdź adres i ref, połączenie z siecią oraz to, czy repozytorium jest publiczne (logowanie nie jest obsługiwane).';

/** Powody przerwania przez CWM w komunikacie z `git-fetch`: sa wlasne, bez sciezek, wiec idą do uzytkownika. */
const ABORT_MESSAGES: readonly [RegExp, string][] = [
  [/przekroczono (?:laczny )?limit czasu/, 'Pobieranie trwało zbyt długo i zostało przerwane.'],
  [
    /przekroczono limit rozmiaru pobierania|za duze wyjscie/,
    'Repozytorium jest za duże i pobieranie zostało przerwane.',
  ],
];

export interface GitImportOptions {
  /** Katalog roboczy pod `userData` (bezwzgledny); powstaje z trybem 0700, a jego zawartosc jest tymczasowa. */
  readonly workDir: string;
  /**
   * Tylko testy: dopuszcza adres http na petli zwrotnej (lokalny serwer z repozytorium utworzonym w tescie).
   * Domyslnie `open` przyjmuje wylacznie adres https, niezaleznie od kontroli w IPC (ADR 0058).
   */
  readonly allowLoopbackHttpForTests?: boolean;
  /** Szew na testy: domyslnie `fetchGitSource`. */
  readonly fetch?: typeof fetchGitSource;
  /** Log bledow nieoczekiwanych (bez wyswietlania uzytkownikowi). */
  readonly onUnexpected?: (error: unknown) => void;
}

export class FsGitSourceProvider implements GitSourceProvider {
  private readonly layout: CwmLayout;
  private readonly fetch: typeof fetchGitSource;
  /** Sprzatanie z chwili startu; `open` czeka na nie, zeby nie usunac kopii wlasnego pobierania. */
  private startup: Promise<void> = Promise.resolve();

  constructor(private readonly options: GitImportOptions) {
    this.layout = createLayout(options.workDir);
    this.fetch = options.fetch ?? fetchGitSource;
  }

  /** Uruchamia sprzatanie po poprzednim (przerwanym) imporcie i zapamietuje obietnice: `open` na nia czeka. */
  purgeAtStart(): void {
    this.startup = this.purge();
  }

  /** Zabija trwajace polecenia `git` (zamykanie aplikacji). */
  abort(): void {
    abortRunningGit();
  }

  /** Usuwa wszystko, co zostalo po poprzednim imporcie i ustawia 0700 na katalogu roboczym. */
  async purge(): Promise<void> {
    try {
      const scope = homeScope(this.options.workDir);
      if (await isDirectory(this.options.workDir)) await secureScopedRoot(scope);
      await removeScopedTree(scope, this.layout.sourcesDir);
    } catch (error: unknown) {
      this.options.onUnexpected?.(error);
    }
  }

  async open(request: GitSourceRequest): Promise<GitSourceOpen> {
    const urlProblem = gitUrlProblem(request.url);
    if (urlProblem !== null) return refuse('rejected', urlProblem);
    if (
      new URL(request.url).protocol !== 'https:' &&
      this.options.allowLoopbackHttpForTests !== true
    ) {
      return refuse('rejected', 'Dozwolony jest tylko adres https.');
    }
    if (request.ref !== null) {
      const refProblem = gitRefProblem(request.ref);
      if (refProblem !== null) return refuse('rejected', refProblem);
    }
    const url = sanitizeGitUrl(request.url);

    let fetched: GitFetchResult;
    try {
      await this.startup;
      await ensureScopedDirectory(homeScope(this.options.workDir), this.options.workDir);
      await secureScopedRoot(homeScope(this.options.workDir));
      await this.purge();
      fetched = await this.fetch({
        layout: this.layout,
        url,
        ref: request.ref,
        commit: null,
      });
    } catch (error: unknown) {
      this.options.onUnexpected?.(error);
      await this.purge();
      return refuse('fetch-failed', GIT_FETCH_FAILED_MESSAGE);
    }
    if (!fetched.ok) {
      await this.purge();
      return failureOf(fetched);
    }

    try {
      const { roots, reader } = await this.detect(fetched.dir, skillNameOf(url));
      let released = false;
      return {
        ok: true,
        source: {
          origin: { url, commit: fetched.commit, ref: request.ref },
          roots,
          reader,
          submodules: fetched.submodules,
          release: async () => {
            if (released) return;
            released = true;
            await this.purge();
          },
        },
      };
    } catch (error: unknown) {
      this.options.onUnexpected?.(error);
      await this.purge();
      return refuse('fetch-failed', GIT_FETCH_FAILED_MESSAGE);
    }
  }

  /** Uklad kopii: znane katalogi (patrz `LAYOUT`) i pojedynczy `SKILL.md` w korzeniu. */
  private async detect(
    dir: string,
    skillName: string,
  ): Promise<{ roots: DetectedRoot[]; reader: SourceReader }> {
    const paths = new Map<RootId, string>();
    const wrapped = new Map<RootId, string>();
    const roots: DetectedRoot[] = [];
    const add = (spec: Pick<LayoutRoot, 'tool' | 'kind'>, label: string, path: string): RootId => {
      const rootId = `git-root-${randomBytes(6).toString('hex')}`;
      paths.set(rootId, path);
      roots.push({ rootId, tool: spec.tool, kind: spec.kind, label, exists: true, active: true });
      return rootId;
    };

    for (const spec of LAYOUT) {
      const path = join(dir, ...spec.segments);
      if (await isDirectory(path)) add(spec, spec.segments.join('/'), path);
    }
    if (await isFile(join(dir, 'SKILL.md'))) {
      const rootId = add({ tool: 'claude-code', kind: 'skills' }, SINGLE_SKILL_LABEL, dir);
      wrapped.set(rootId, skillName);
    }
    const reader = new SingleSkillReader(
      new FsSourceReader((rootId) => paths.get(rootId) ?? null),
      wrapped,
    );
    return { roots, reader };
  }
}

/**
 * Nazwa wirtualnego katalogu pojedynczego skilla: ostatni segment adresu bez `.git`, czyli nazwa
 * repozytorium. Adapter robi z niej nazwe elementu; nietypowa nazwa daje `skill`.
 */
function skillNameOf(url: string): string {
  const last =
    new URL(url).pathname
      .split('/')
      .filter((part) => part !== '')
      .pop() ?? '';
  const name = last.replace(/\.git$/i, '');
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) ? name : 'skill';
}

function refuse(code: GitSourceFailure, message: string): GitSourceOpen {
  return { ok: false, code, message };
}

/**
 * Komunikat dla uzytkownika z odmowy `git-fetch`. Wyjscie procesu `git` (stderr serwera, sciezka katalogu
 * roboczego) nie wychodzi poza main, wiec odmowy z procesu dostaja komunikat staly; wlasne komunikaty CWM
 * (limity, dowiazania, niezgodne obiekty) nie zawieraja sciezek i ida dalej.
 */
function failureOf(fetched: Extract<GitFetchResult, { ok: false }>): GitSourceOpen {
  if (fetched.kind === 'git-missing') return refuse('git-unavailable', GIT_UNAVAILABLE_MESSAGE);
  if (fetched.kind === 'process') {
    const known = ABORT_MESSAGES.find(([pattern]) => pattern.test(fetched.message));
    return refuse('fetch-failed', known === undefined ? GIT_FETCH_FAILED_MESSAGE : known[1]);
  }
  if (/miejsca na dysku/.test(fetched.message)) {
    return refuse('fetch-failed', 'Za mało wolnego miejsca na dysku, żeby pobrać repozytorium.');
  }
  const detail = fetched.message.replace(/^repozytorium nie nadaje sie na plugin: /, '');
  return refuse('rejected', `Repozytorium odrzucone przez kontrolę bezpieczeństwa: ${detail}.`);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}
