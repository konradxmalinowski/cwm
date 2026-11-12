import { join } from 'node:path';

import {
  API_VERSION,
  RESOURCE_KINDS,
  RESOURCE_SET_KEYS,
  validateResource,
  type ContentFlags,
  type Resource,
  type ResourceKind,
} from '../../core/cwm';
import { readBounded } from '../fs/bounded-read';
import { lstatOrNull } from '../fs/stat';
import {
  companyDir,
  isSafeSegment,
  registryKindDir,
  resourceFileName,
  type CwmLayout,
} from './layout';
import {
  IMPORT_LIMITS,
  type Candidate,
  type ImportKind,
  type ReportItem,
  type SourceFile,
} from './import-types';
import { readDirLimited } from './read';
import { toYaml } from './serialize';
import { parseManifestYaml } from './yaml-manifest';
import { homeScope, replaceScopedTree, type ScopedTreeFile } from './writer';

/** Wersja nadawana importowanym zasobom: natywna konfiguracja nie ma wersji. */
export const IMPORTED_VERSION = '0.1.0';

export type ImportTarget =
  { readonly scope: 'global' } | { readonly scope: 'company'; readonly company: string };

export type PlanStatus = 'new' | 'changed' | 'unchanged';

export interface PlanItem {
  readonly kind: ImportKind;
  readonly id: string;
  readonly label: string;
  readonly dir: string;
  readonly status: PlanStatus;
  /** Zmienione sekcje Settings (nazwy, bez wartosci) albo zmienione pliki innych zasobow. */
  readonly changes: readonly string[];
  readonly files: readonly ScopedTreeFile[];
  readonly flags: ContentFlags;
  readonly notes: readonly ReportItem[];
  /** Pochodzenie (IMP-01): sciezka zrodla po realpath i skrot kopiowanego drzewa. */
  readonly source: string;
  readonly sha256: string;
}

/** Oznaczony plik w planie: powod i wiersz, bez tresci. `path` jest wzgledne wobec --from. */
export interface PlanFlagged {
  readonly label: string;
  readonly path: string;
  readonly reason: string;
  readonly line: number | null;
  readonly hard: boolean;
  readonly included: boolean;
}

export interface ImportPlan {
  readonly target: ImportTarget;
  readonly items: readonly PlanItem[];
  readonly skipped: readonly ReportItem[];
  readonly flagged: readonly PlanFlagged[];
}

const MANIFEST_KIND: Record<ImportKind, string> = {
  skill: 'Skill',
  agent: 'Agent',
  command: 'Command',
  settings: 'Settings',
  files: 'Files',
};
const MAX_EXISTING_FILES = IMPORT_LIMITS.skillFiles + 100;

export function targetNamespace(target: ImportTarget): string {
  return target.scope === 'global' ? 'global' : target.company;
}

export function resourceDirFor(
  layout: CwmLayout,
  kind: ResourceKind,
  target: ImportTarget,
  name: string,
): string {
  return target.scope === 'global'
    ? join(registryKindDir(layout, kind), 'global', name)
    : join(companyDir(layout, target.company), RESOURCE_SET_KEYS[kind], name);
}

function manifestDocument(candidate: Candidate, id: string): unknown {
  const metadata = { id, version: IMPORTED_VERSION };
  const base = { apiVersion: API_VERSION, kind: MANIFEST_KIND[candidate.kind], metadata };
  const contentFlags = { ...candidate.flags };
  const native = candidate.nativeDir === undefined ? {} : { nativeDir: candidate.nativeDir };
  switch (candidate.kind) {
    case 'skill':
      return { ...base, spec: { source: candidate.source, contentFlags, ...native } };
    case 'command':
      return { ...base, spec: { source: candidate.source, contentFlags, ...native } };
    case 'agent':
      return {
        ...base,
        spec: {
          source: candidate.source,
          ...(candidate.tools.length > 0 ? { tools: [...candidate.tools] } : {}),
          ...(candidate.model === null ? {} : { model: candidate.model }),
          contentFlags,
          ...native,
        },
      };
    case 'settings':
      return { ...base, spec: candidate.spec ?? {} };
    case 'files':
      return {
        ...base,
        spec: { root: candidate.filesSpec?.root, path: candidate.filesSpec?.path, ...native },
      };
  }
}

/** JSON z posortowanymi kluczami, do porownan sekcji. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return inner;
    const record = inner as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((k) => [k, record[k]]),
    );
  });
}

type Existing = 'absent' | 'unreadable' | ReadonlyMap<string, Uint8Array>;

async function readExisting(dir: string): Promise<Existing> {
  const info = await lstatOrNull(dir);
  if (info === null) return 'absent';
  if (!info.isDirectory()) return 'unreadable';
  const files = new Map<string, Uint8Array>();
  const stack = [{ path: dir, rel: '' }];
  try {
    for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
      const listing = await readDirLimited(frame.path, 1000);
      if (listing.truncated) return 'unreadable';
      for (const entry of listing.entries) {
        const rel = frame.rel === '' ? entry.name : `${frame.rel}/${entry.name}`;
        const path = join(frame.path, entry.name);
        if (entry.isDirectory()) stack.push({ path, rel });
        else if (entry.isFile()) {
          if (files.size >= MAX_EXISTING_FILES) return 'unreadable';
          const read = await readBounded(path, IMPORT_LIMITS.fileBytes);
          if (read.truncated) return 'unreadable';
          files.set(rel, read.bytes);
        } else return 'unreadable';
      }
    }
  } catch {
    return 'unreadable';
  }
  return files;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => Buffer.compare(a, b) === 0;

function settingsOf(bytes: Uint8Array | undefined): Resource | null {
  if (bytes === undefined) return null;
  const parsed = parseManifestYaml(new TextDecoder().decode(bytes));
  if (!parsed.ok) return null;
  const checked = validateResource(parsed.value);
  return checked.ok ? checked.value : null;
}

function diffSections(old: Uint8Array | undefined, next: Uint8Array): string[] {
  const before = settingsOf(old);
  const after = settingsOf(next);
  if (before?.kind !== 'settings' || after?.kind !== 'settings') return ['plik'];
  const sections: string[] = [];
  if (stableJson(before.hooks) !== stableJson(after.hooks)) sections.push('hooks');
  if (stableJson(before.permissions) !== stableJson(after.permissions))
    sections.push('permissions');
  if (stableJson(before.env) !== stableJson(after.env)) sections.push('env');
  if (before.enforce !== after.enforce) sections.push('enforce');
  return sections;
}

function compare(
  existing: Existing,
  next: ReadonlyMap<string, Uint8Array>,
  kind: ImportKind,
): { status: PlanStatus; changes: string[] } {
  if (existing === 'absent') return { status: 'new', changes: [] };
  if (existing === 'unreadable') return { status: 'changed', changes: ['katalog'] };
  const changed: string[] = [];
  for (const [rel, bytes] of next) {
    const old = existing.get(rel);
    if (old === undefined || !sameBytes(old, bytes)) changed.push(rel);
  }
  for (const rel of existing.keys()) if (!next.has(rel)) changed.push(rel);
  if (changed.length === 0) return { status: 'unchanged', changes: [] };
  if (kind === 'settings') {
    const file = resourceFileName('settings');
    return {
      status: 'changed',
      changes: diffSections(existing.get(file), next.get(file) ?? new Uint8Array()),
    };
  }
  return { status: 'changed', changes: changed.sort().slice(0, 10) };
}

function toTreeFiles(
  manifestName: string,
  manifest: string,
  files: readonly SourceFile[],
): ScopedTreeFile[] {
  return [
    { rel: manifestName, bytes: new TextEncoder().encode(manifest), executable: false },
    ...files.map((file) => ({ rel: file.rel, bytes: file.bytes, executable: file.executable })),
  ];
}

/**
 * Plan importu: id i katalog docelowy kazdego zasobu, status wobec rejestru (nowy, zmieniony, bez
 * zmian) i pelna lista plikow do zapisu. Kolizje nazw po normalizacji (takze same wielkosci liter)
 * pomijaja wszystkie strony kolizji z raportem. Nic nie jest zapisywane.
 */
export async function buildImportPlan(
  layout: CwmLayout,
  target: ImportTarget,
  candidates: readonly Candidate[],
  scanSkipped: readonly ReportItem[],
): Promise<ImportPlan> {
  if (target.scope === 'company' && !isSafeSegment(target.company)) {
    throw new Error('Niepoprawne id firmy.');
  }
  const skipped: ReportItem[] = [...scanSkipped];
  const namespace = targetNamespace(target);

  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.kind}:${candidate.name}`;
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  const kindsByName = new Map<string, Set<ImportKind>>();
  for (const candidate of candidates) {
    const kinds = kindsByName.get(candidate.name) ?? new Set<ImportKind>();
    kinds.add(candidate.kind);
    kindsByName.set(candidate.name, kinds);
  }

  const items: PlanItem[] = [];
  /** Oznaczone pliki pokazujemy tylko dla zasobow, ktore nie wypadly z planu z innego powodu. */
  const reviewable = new Set<string>();
  for (const group of groups.values()) {
    const first = group[0];
    if (first === undefined) continue;
    if (group.length > 1) {
      const names = group.map((c) => c.label).join(', ');
      for (const candidate of group) {
        skipped.push({
          item: candidate.label,
          reason: `kolizja nazw po normalizacji do "${first.name}" (${names}); zadna z nich nie jest importowana`,
        });
      }
      continue;
    }
    if (first.kind !== 'settings' && first.files.length === 0) {
      reviewable.add(first.label);
      skipped.push({
        item: first.label,
        reason:
          'brak plikow do skopiowania (pominiete albo oznaczone jako mozliwy sekret: dolacz je albo pomin)',
      });
      continue;
    }
    const id = `${namespace}/${first.name}`;
    const document = manifestDocument(first, id);
    const manifest = toYaml(document);
    const roundTrip = parseManifestYaml(manifest);
    const checked = roundTrip.ok ? validateResource(roundTrip.value) : null;
    if (checked === null || !checked.ok) {
      const detail = checked && !checked.ok ? checked.errors[0] : undefined;
      skipped.push({
        item: first.label,
        reason: `manifest nie przechodzi walidacji${detail ? ` (${detail.path}: ${detail.message})` : ''}`,
      });
      continue;
    }
    const manifestName = resourceFileName(first.kind);
    const treeFiles = toTreeFiles(manifestName, manifest, first.files);
    const dir = resourceDirFor(layout, first.kind, target, first.name);
    const next = new Map(treeFiles.map((file) => [file.rel, file.bytes]));
    const { status, changes } = compare(await readExisting(dir), next, first.kind);

    const notes = [...first.notes];
    const sameName = kindsByName.get(first.name);
    if (sameName !== undefined && sameName.size > 1) {
      notes.push({
        item: first.label,
        reason: `id ${id} jest wspolne z innym rodzajem zasobu: nie wlaczaj ich razem w jednej konfiguracji`,
      });
    }
    for (const other of RESOURCE_KINDS) {
      if (other === first.kind) continue;
      const otherDir = resourceDirFor(layout, other, target, first.name);
      if ((await lstatOrNull(otherDir)) !== null) {
        notes.push({
          item: first.label,
          reason: `w rejestrze istnieje juz zasob ${other} o id ${id}: nie wlaczaj ich razem`,
        });
      }
    }
    reviewable.add(first.label);
    items.push({
      kind: first.kind,
      id,
      label: first.label,
      dir,
      status,
      changes,
      files: treeFiles,
      flags: first.flags,
      notes,
      source: first.sourceReal,
      sha256: first.sha256,
    });
  }
  items.sort((a, b) =>
    a.kind + a.id < b.kind + b.id ? -1 : a.kind + a.id > b.kind + b.id ? 1 : 0,
  );
  const flagged = candidates
    .filter((candidate) => reviewable.has(candidate.label))
    .flatMap((candidate) =>
      candidate.flagged.map((f): PlanFlagged => ({
        label: candidate.label,
        path: f.path,
        reason: f.reason,
        line: f.line,
        hard: f.hard,
        included: f.included,
      })),
    );
  return { target, items, skipped, flagged };
}

export interface ApplyResult {
  readonly id: string;
  readonly kind: ImportKind;
  readonly ok: boolean;
  readonly message?: string;
  readonly warnings: readonly string[];
}

/**
 * Zapis nowych i zmienionych zasobow (bez zmian pomijane). Tresc pochodzi z planu, ktory
 * uzytkownik zatwierdzil, nie z ponownego odczytu zrodla. Blad jednego zasobu nie przerywa reszty.
 */
export async function applyImportPlan(
  layout: CwmLayout,
  plan: ImportPlan,
  describeError: (error: unknown) => string,
): Promise<ApplyResult[]> {
  const scope = homeScope(layout.home);
  const results: ApplyResult[] = [];
  for (const item of plan.items) {
    if (item.status === 'unchanged') continue;
    try {
      const { warnings } = await replaceScopedTree(scope, item.dir, item.files);
      results.push({ id: item.id, kind: item.kind, ok: true, warnings });
    } catch (error: unknown) {
      results.push({
        id: item.id,
        kind: item.kind,
        ok: false,
        message: describeError(error),
        warnings: [],
      });
    }
  }
  return results;
}
