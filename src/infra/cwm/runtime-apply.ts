import { HASH64, canonicalJson, validateCleanupPath } from '../../core/cwm';
import { AtomicWriteError } from '../fs/atomic';
import { errnoCode } from '../fs/store-error';
import {
  backupFile,
  backupRevoked,
  clearBackups,
  ensureProfileDir,
  pruneEmptyDirs,
  readManifestText,
  readRuntimeFile,
  removeManifest,
  removeRuntimeFile,
  tmpDirFor,
  writeManifestText,
  writeRuntimeFile,
  type RuntimeRoot,
} from './runtime-fs';
import { WriteDeniedError } from './writer';
import type { PlannedFile, RuntimePlan } from './runtime-plan';
import { sha256Hex } from './runtime-sources';

/**
 * Zapis planu do `runtime/<firma>` (PRF-02, PRF-03, APR-04 kroki 5-6): plik po pliku, z kopia
 * poprzednich wersji, odczytem kontrolnym i manifestem zapisanym jako ostatni. Usuwa wylacznie
 * to, co jest w poprzednim manifescie, przechodzi walidacje sciezki i ma ten sam skrot co w manifescie.
 */

export interface ManifestFile {
  readonly path: string;
  readonly sha256: string;
  readonly area: string;
}

export interface GenerationManifest {
  readonly v: 1;
  readonly company: string;
  readonly generatedAt: string;
  readonly files: readonly ManifestFile[];
}

export function areaOf(rel: string): string {
  const parts = rel.split('/');
  if (parts[0] === 'claude') return 'profile';
  if (parts[0] === 'sessions') return `session:${parts[1] ?? ''}`;
  return `plugin:${parts[1] ?? ''}`;
}

/** Manifest to dane z dysku: kazda sciezka przechodzi walidacje, a kazdy blad daje `null` (nic nie jest usuwane). */
export function parseGenerationManifest(text: string, company: string): GenerationManifest | null {
  try {
    const raw = JSON.parse(text) as unknown;
    if (typeof raw !== 'object' || raw === null) return null;
    const m = raw as Record<string, unknown>;
    if (m['v'] !== 1 || m['company'] !== company || typeof m['generatedAt'] !== 'string')
      return null;
    if (!Array.isArray(m['files']) || m['files'].length > 20_000) return null;
    const files: ManifestFile[] = [];
    for (const item of m['files'] as unknown[]) {
      if (typeof item !== 'object' || item === null) return null;
      const f = item as Record<string, unknown>;
      if (
        typeof f['path'] !== 'string' ||
        typeof f['sha256'] !== 'string' ||
        !HASH64.test(f['sha256']) ||
        !validateCleanupPath(f['path']).ok
      ) {
        return null;
      }
      files.push({ path: f['path'], sha256: f['sha256'], area: areaOf(f['path']) });
    }
    return { v: 1, company, generatedAt: m['generatedAt'], files };
  } catch {
    return null;
  }
}

export interface LoadedManifest {
  readonly manifest: GenerationManifest | null;
  readonly corrupt: boolean;
}

export async function loadGenerationManifest(root: RuntimeRoot): Promise<LoadedManifest> {
  const text = await readManifestText(root);
  if (text === null) return { manifest: null, corrupt: false };
  const manifest = parseGenerationManifest(text, root.company);
  return { manifest, corrupt: manifest === null };
}

function serialize(root: RuntimeRoot, files: readonly ManifestFile[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : 1));
  const document: GenerationManifest = {
    v: 1,
    company: root.company,
    generatedAt: new Date().toISOString(),
    files: sorted.map((f) => ({ path: f.path, sha256: f.sha256, area: f.area })),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

function topLevelKeys(bytes: Uint8Array): Map<string, string> | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return new Map(Object.entries(value).map(([key, item]) => [key, canonicalJson(item)]));
  } catch {
    return null;
  }
}

/** Nazwy kluczy `settings.json`, ktore sie roznia (PRF-05). Bez wartosci: `env` moze miec dane. */
function changedKeys(before: Uint8Array, after: Uint8Array): string[] {
  const a = topLevelKeys(before);
  const b = topLevelKeys(after);
  if (a === null || b === null) return ['(plik nie jest obiektem JSON)'];
  return [...new Set([...a.keys(), ...b.keys()])].filter((key) => a.get(key) !== b.get(key)).sort();
}

export interface RuntimeApplyResult {
  readonly written: readonly string[];
  readonly unchanged: number;
  readonly removed: readonly string[];
  readonly backedUp: readonly string[];
  readonly warnings: readonly string[];
}

export class ApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplyError';
  }
}

interface Change {
  readonly file: PlannedFile;
  readonly previous: Uint8Array | null;
}

export interface ApplyOptions {
  /** Migawki pluginow (`<slug>@<skrot>`) uzywane przez trwajace sesje: nie sa sprzatane (SEC-15). */
  readonly livePlugins?: ReadonlySet<string>;
}

const expectedMode = (executable: boolean): number => (executable ? 0o700 : 0o600);

export async function applyPlan(
  root: RuntimeRoot,
  plan: RuntimePlan,
  options: ApplyOptions = {},
): Promise<RuntimeApplyResult> {
  const warnings: string[] = [];
  const loaded = await loadGenerationManifest(root);
  if (loaded.corrupt) {
    warnings.push(
      'manifest generowania jest uszkodzony: nic nie jest usuwane, pliki spoza planu zostaja',
    );
  }
  const prev = loaded.manifest?.files ?? [];
  const prevByPath = new Map(prev.map((f) => [f.path, f]));
  const desired = new Map(plan.files.map((f) => [f.rel, f]));
  const areas = new Set(plan.files.map((f) => areaOf(f.rel)));
  areas.add('profile');
  areas.add(`session:${plan.projectHash}`);
  // Nieaktualne migawki pluginow, z ktorych nie korzysta zadna trwajaca sesja, sa sprzatane wg manifestu.
  for (const entry of prev) {
    if (entry.area.startsWith('plugin:') && !areas.has(entry.area)) {
      if (!(options.livePlugins?.has(entry.area.slice('plugin:'.length)) ?? false)) {
        areas.add(entry.area);
      }
    }
  }
  const prevManifestText = await readManifestText(root);

  await ensureProfileDir(root);
  await tmpDirFor(root);

  const changes: Change[] = [];
  let unchanged = 0;
  for (const file of plan.files) {
    const read = await readRuntimeFile(root, file.rel);
    if (read.kind === 'unsafe') throw new ApplyError(`Niebezpieczny plik w profilu: ${file.rel}`);
    if (read.kind === 'missing') {
      changes.push({ file, previous: null });
      continue;
    }
    if (sha256Hex(read.bytes) === file.sha256) {
      if (read.mode === expectedMode(file.executable)) {
        unchanged += 1;
      } else {
        changes.push({ file, previous: read.bytes });
      }
      continue;
    }
    const owned = prevByPath.get(file.rel);
    const isSettings = file.rel === 'claude/settings.json';
    if (owned === undefined && !isSettings) {
      throw new ApplyError(
        `Plik ${file.rel} istnieje i nie pochodzi z CWM. Usun go albo przenies, zanim uruchomisz cwm start.`,
      );
    }
    if (owned !== undefined && owned.sha256 !== sha256Hex(read.bytes)) {
      warnings.push(`${file.rel} zostal zmieniony poza CWM (kopia w generated/prev)`);
    }
    if (isSettings) {
      warnings.push(
        `settings.json profilu zastapiony (kopia w generated/prev); zmienione klucze: ${changedKeys(read.bytes, file.bytes).join(', ') || '-'}`,
      );
    }
    changes.push({ file, previous: read.bytes });
  }

  const deletions: string[] = [];
  const current = new Map<string, Uint8Array>();
  for (const entry of prev) {
    if (!areas.has(entry.area) || desired.has(entry.path)) continue;
    const read = await readRuntimeFile(root, entry.path);
    if (read.kind === 'missing') continue;
    if (read.kind === 'unsafe') {
      warnings.push(`${entry.path}: pominiety przy sprzataniu (niebezpieczny)`);
    } else if (sha256Hex(read.bytes) !== entry.sha256) {
      warnings.push(`${entry.path}: zmieniony poza CWM, zostaje na miejscu`);
    } else {
      deletions.push(entry.path);
      current.set(entry.path, read.bytes);
    }
  }

  await clearBackups(root);
  const backedUp: string[] = [];
  for (const change of changes) {
    if (change.previous !== null) {
      await backupFile(root, change.file.rel, change.previous);
      backedUp.push(change.file.rel);
    }
  }
  for (const path of deletions) {
    const bytes = current.get(path);
    if (bytes !== undefined) {
      await backupFile(root, path, bytes);
      backedUp.push(path);
    }
  }

  const written: Change[] = [];
  const removedNow: string[] = [];
  const rollback = async (): Promise<void> => {
    for (const path of removedNow) {
      const bytes = current.get(path);
      if (bytes !== undefined) await writeRuntimeFile(root, path, bytes).catch(() => undefined);
    }
    if (prevManifestText === null) await removeManifest(root).catch(() => undefined);
    else await writeManifestText(root, prevManifestText).catch(() => undefined);
    for (const change of written.reverse()) {
      try {
        if (change.previous === null) await removeRuntimeFile(root, change.file.rel);
        else await writeRuntimeFile(root, change.file.rel, change.previous, change.file.executable);
      } catch {
        warnings.push(
          `rollback: nie udalo sie przywrocic ${change.file.rel} (kopia w generated/prev)`,
        );
      }
    }
  };

  try {
    for (const change of changes) {
      await writeRuntimeFile(root, change.file.rel, change.file.bytes, change.file.executable);
      written.push(change);
    }
    for (const file of plan.files) {
      const read = await readRuntimeFile(root, file.rel);
      if (read.kind !== 'ok' || sha256Hex(read.bytes) !== file.sha256) {
        throw new ApplyError(`Odczyt kontrolny nie zgadza sie ze skrotem planu: ${file.rel}`);
      }
    }
    const kept = prev.filter((f) => !areas.has(f.area));
    const toManifest = (files: readonly { rel: string; sha256: string }[]): ManifestFile[] =>
      files.map((f) => ({ path: f.rel, sha256: f.sha256, area: areaOf(f.rel) }));
    const pending = deletions.map((path) => {
      const entry = prevByPath.get(path);
      return { rel: path, sha256: entry?.sha256 ?? '' };
    });
    await writeManifestText(
      root,
      serialize(root, [...kept, ...toManifest(plan.files), ...toManifest(pending)]),
    );
    for (const path of deletions) {
      await removeRuntimeFile(root, path);
      removedNow.push(path);
      await pruneEmptyDirs(root, path);
    }
    await writeManifestText(root, serialize(root, [...kept, ...toManifest(plan.files)]));
  } catch (error: unknown) {
    await rollback();
    if (
      error instanceof ApplyError ||
      error instanceof WriteDeniedError ||
      error instanceof AtomicWriteError
    ) {
      throw error;
    }
    throw new ApplyError(
      `Zapis profilu nie powiodl sie (${errnoCode(error) ?? 'nieznany'}); przywrocono poprzedni stan.`,
    );
  }
  return {
    written: changes.map((c) => c.file.rel),
    unchanged,
    removed: deletions,
    backedUp,
    warnings,
  };
}

export interface InvalidateResult {
  readonly removed: number;
  /** Pliki zmienione przez silnik, z ktorych usunieto tylko klucze CWM (kopia w `generated/revoked/`). */
  readonly cleaned: readonly string[];
  /** Pliki z tresciami CWM, ktorych nie dalo sie usunac: odwolanie jest wtedy niepelne. */
  readonly kept: readonly string[];
}

/** Klucze `settings.json`, ktore zapisuje CWM (hooki, uprawnienia, env); silnik trzyma w nim reszte. */
const CWM_SETTINGS_KEYS = ['hooks', 'permissions', 'env'] as const;

async function stripCwmKeys(root: RuntimeRoot, path: string, bytes: Uint8Array): Promise<boolean> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return false;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = { ...(value as Record<string, unknown>) };
  await backupRevoked(root, path, bytes);
  for (const key of CWM_SETTINGS_KEYS) delete record[key];
  await writeRuntimeFile(
    root,
    path,
    new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`),
  );
  const check = await readRuntimeFile(root, path);
  if (check.kind !== 'ok') return false;
  const after = JSON.parse(new TextDecoder().decode(check.bytes)) as Record<string, unknown>;
  return CWM_SETTINGS_KEYS.every((key) => !(key in after));
}

/**
 * Uniewaznienie wygenerowanych artefaktow (APR-08, SEC-05): pliki z manifestu o zgodnym skrocie sa
 * usuwane. `settings.json` zmieniony przez silnik traci tylko klucze CWM (kopia w
 * `generated/revoked/`), bo inaczej hooki z profilu dzialalyby dalej. Co zostaje, jest raportowane.
 */
export async function invalidateGenerated(root: RuntimeRoot): Promise<InvalidateResult> {
  const loaded = await loadGenerationManifest(root);
  if (loaded.manifest === null)
    return { removed: 0, cleaned: [], kept: loaded.corrupt ? ['generated/manifest.json'] : [] };
  let removed = 0;
  const cleaned: string[] = [];
  const kept: string[] = [];
  for (const entry of loaded.manifest.files) {
    const read = await readRuntimeFile(root, entry.path);
    if (read.kind === 'missing') continue;
    if (read.kind === 'ok' && sha256Hex(read.bytes) === entry.sha256) {
      await removeRuntimeFile(root, entry.path);
      await pruneEmptyDirs(root, entry.path);
      removed += 1;
    } else if (read.kind === 'ok' && entry.path === 'claude/settings.json') {
      if (await stripCwmKeys(root, entry.path, read.bytes)) cleaned.push(entry.path);
      else kept.push(entry.path);
    } else {
      kept.push(entry.path);
    }
  }
  if (kept.length === 0) await removeManifest(root);
  return { removed, cleaned, kept };
}
