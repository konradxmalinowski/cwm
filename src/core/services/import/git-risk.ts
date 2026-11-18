import type { ImportCandidate, ImportWarning } from '../../ports/tool-adapter';

/**
 * Kontrola elementu z repozytorium Git przed zapisem do biblioteki (ADR 0058, punkt o polach
 * wykonawczych). Frontmatter agenta, komendy albo skilla z cudzego repozytorium moze deklarowac
 * hooki, serwery MCP, tryb uprawnien i listy narzedzi. Eksport do tego samego narzedzia odtwarza
 * bajty zrodla, wiec takie pole wrocilby do narzedzia i zostalo tam uruchomione. Dlatego:
 *
 * - `hooks`, `mcpServers` i `permissionMode` sa usuwane z frontmattera (z pliku zrodla w snapshocie),
 *   a decyzja trafia do ostrzezenia przy elemencie i do notatki w historii;
 * - `tools` i `allowed-tools` zostaja, ale element dostaje ostrzezenie;
 * - plik TOML (agent Codeksa, komenda Gemini CLI) z takim polem jest pomijany w calosci, bo nie ma
 *   bezpiecznego sposobu na wyciecie klucza z TOML bez zmiany reszty;
 * - frontmatter, w ktorym po wycieciu nadal widac taki klucz (inna skladnia YAML), tez jest pomijany.
 *
 * Czysta funkcja: nie czyta dysku, nie ufa adapterowi, dziala na bajtach pliku glownego elementu.
 */

const DROPPED = new Set([
  'hooks',
  'mcpServers',
  'mcp_servers',
  'permissionMode',
  'permission_mode',
]);
const WARNED = new Set([
  'tools',
  'allowed-tools',
  'allowedTools',
  'disallowedTools',
  'disallowed-tools',
]);
const TOML_REJECTED = new Set([...DROPPED, 'approval_policy', 'sandbox_permissions']);

const TOP_KEY = /^(?:"([^"\n]+)"|'([^'\n]+)'|([^\s#:\-"'][^:\n]*?))\s*:(?:\s|$)/;
const ANY_DROPPED_KEY =
  /(?:^|[{,\s])["']?(hooks|mcpServers|mcp_servers|permissionMode|permission_mode)["']?\s*:/m;

export interface GitCandidateReview {
  /** Element po oczyszczeniu; `null`, gdy trzeba go pominac. */
  readonly candidate: ImportCandidate | null;
  /** Powod pominiecia (po polsku, bez sciezek), gdy `candidate` jest `null`. */
  readonly rejection: string | null;
  /** Pola usuniete z frontmattera przy imporcie. */
  readonly dropped: readonly string[];
}

interface FrontmatterRegion {
  readonly start: number;
  readonly end: number;
  readonly lines: readonly string[];
}

function region(text: string): FrontmatterRegion | null {
  const lines = text.split('\n');
  if ((lines[0] ?? '').replace(/^﻿/, '').trimEnd() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    const line = (lines[i] ?? '').trimEnd();
    if (line === '---' || line === '...') return { start: 1, end: i, lines };
  }
  return null;
}

function topLevelKey(line: string): string | null {
  const match = TOP_KEY.exec(line);
  if (match === null) return null;
  return (match[1] ?? match[2] ?? match[3] ?? '').trim();
}

function frontmatterKeys(found: FrontmatterRegion): string[] {
  const keys: string[] = [];
  for (let i = found.start; i < found.end; i++) {
    const key = topLevelKey(found.lines[i] ?? '');
    if (key !== null) keys.push(key);
  }
  return keys;
}

/** Usuwa klucze najwyzszego poziomu razem z ich wciętymi liniami. Konce linii zostaja bez zmian. */
function strip(found: FrontmatterRegion, drop: ReadonlySet<string>): string {
  const out: string[] = [...found.lines.slice(0, found.start)];
  let dropping = false;
  for (let i = found.start; i < found.end; i++) {
    const line = found.lines[i] ?? '';
    const key = topLevelKey(line);
    if (key !== null) dropping = drop.has(key);
    if (!dropping) out.push(line);
  }
  out.push(...found.lines.slice(found.end));
  return out.join('\n');
}

function tomlRiskyKeys(text: string): string[] {
  const hits = new Set<string>();
  for (const line of text.split('\n')) {
    const table = /^\s*\[+\s*([A-Za-z0-9_-]+)/.exec(line);
    const key = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    const name = table?.[1] ?? key?.[1];
    if (name === undefined) continue;
    if (TOML_REJECTED.has(name)) hits.add(name);
    // Piaskownica tylko do odczytu zaweza uprawnienia, wiec nie jest powodem do odmowy.
    if (name === 'sandbox_mode' && key !== null && !/^["']read-only["']/.test(key[2] ?? '')) {
      hits.add(name);
    }
  }
  return [...hits];
}

const utf8 = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
const encoder = new TextEncoder();

export function reviewGitCandidate(candidate: ImportCandidate): GitCandidateReview {
  const reject = (rejection: string): GitCandidateReview => ({
    candidate: null,
    rejection,
    dropped: [],
  });
  const dropped = new Set<string>();
  const warned = new Set<string>();
  const snapshots = candidate.draft.source?.snapshots ?? [];
  const next = [];
  for (const snapshot of snapshots) {
    const main = snapshot.files[0];
    if (main === undefined) {
      next.push(snapshot);
      continue;
    }
    const text = utf8.decode(main.bytes);
    if (/\.toml$/i.test(main.relPath)) {
      const risky = tomlRiskyKeys(text);
      if (risky.length > 0) {
        return reject(
          `Element z repozytorium deklaruje pola wykonawcze (${risky.join(', ')}) w pliku TOML, którego nie da się bezpiecznie oczyścić, więc nie jest importowany.`,
        );
      }
      next.push(snapshot);
      continue;
    }
    const found = /\.md$/i.test(main.relPath) ? region(text) : null;
    if (found === null) {
      next.push(snapshot);
      continue;
    }
    const keys = frontmatterKeys(found);
    for (const key of keys) {
      if (WARNED.has(key)) warned.add(key);
    }
    const drop = keys.filter((key) => DROPPED.has(key));
    for (const key of drop) dropped.add(key);
    const cleaned = drop.length === 0 ? text : strip(found, new Set(drop));
    const after = region(cleaned);
    if (
      after !== null &&
      ANY_DROPPED_KEY.test(after.lines.slice(after.start, after.end).join('\n'))
    ) {
      return reject(
        'Element z repozytorium deklaruje hooki, serwery MCP albo tryb uprawnień w formie, której importer nie potrafi bezpiecznie usunąć, więc nie jest importowany.',
      );
    }
    if (drop.length === 0) {
      next.push(snapshot);
      continue;
    }
    const gone = new Set(drop.map((key) => `frontmatter.${key}`));
    next.push({
      ...snapshot,
      files: [{ ...main, bytes: encoder.encode(cleaned) }, ...snapshot.files.slice(1)],
      unmappedKeys: snapshot.unmappedKeys.filter((entry) => !gone.has(entry.path)),
    });
  }

  const warnings: ImportWarning[] = [...candidate.warnings];
  if (dropped.size > 0) {
    warnings.push({
      code: 'git-executable-fields-dropped',
      message: `Element z repozytorium deklarował pola wykonawcze (${[...dropped].join(', ')}): hooki, serwery MCP albo tryb uprawnień. Aplikacja usunęła je przy imporcie, więc nie trafią do biblioteki ani do eksportu.`,
    });
  }
  if (warned.size > 0) {
    warnings.push({
      code: 'git-tools-declared',
      message: `Element z repozytorium deklaruje narzędzia (${[...warned].join(', ')}). Po eksporcie narzędzie będzie mogło ich używać, więc zaznacz element tylko wtedy, gdy ufasz temu repozytorium.`,
    });
  }
  const draft =
    snapshots.length === 0 || candidate.draft.source === undefined
      ? candidate.draft
      : { ...candidate.draft, source: { ...candidate.draft.source, snapshots: next } };
  return { candidate: { ...candidate, draft, warnings }, rejection: null, dropped: [...dropped] };
}
