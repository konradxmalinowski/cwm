import { join } from 'node:path';

import {
  API_VERSION,
  RESOURCE_KINDS,
  validateApprovalsFile,
  type ApprovalRecord,
  type ApprovalsFile,
  type ApprovalSubject,
  type ResourceKind,
} from '../../core/cwm';
import { lstatLoose } from './paths';
import { acquireMutex, openRuntimeRoot, peekRuntimeRoot, type RuntimeRoot } from './runtime-fs';
import { listDirectory, readTextWithin } from './read';
import { isSafeSegment, type CwmLayout } from './layout';
import { parseManifestYaml } from './yaml-manifest';
import { toYaml } from './serialize';
import { ensureScopedDirectory, homeScope, WriteDeniedError, writeScopedFile } from './writer';

const MAX_APPROVALS_BYTES = 1024 * 1024;

export const approvalsDir = (layout: CwmLayout): string => join(layout.home, 'approvals');
export const approvalsFile = (layout: CwmLayout, company: string): string =>
  join(approvalsDir(layout), `${company}.yaml`);

export type ApprovalsLoad =
  | { readonly state: 'ok'; readonly file: ApprovalsFile }
  | { readonly state: 'missing' }
  | { readonly state: 'corrupt'; readonly message: string };

/**
 * Odczyt zatwierdzen firmy (APR-05): bez dowiazan, limit 1 MiB, wlasciciel rowny biezacemu
 * uzytkownikowi, plik niezapisywalny dla grupy i innych, ostry walidator. Uszkodzony plik to
 * `corrupt`, czyli nic nie jest zatwierdzone, nigdy wyjatek i nigdy "wszystko".
 */
export async function loadApprovals(layout: CwmLayout, company: string): Promise<ApprovalsLoad> {
  if (!isSafeSegment(company)) return { state: 'corrupt', message: 'Niepoprawne id firmy.' };
  const file = approvalsFile(layout, company);
  const info = await lstatLoose(file);
  if (info === null) return { state: 'missing' };
  if (!info.isFile())
    return { state: 'corrupt', message: 'Plik zatwierdzen nie jest zwyklym plikiem.' };
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      return { state: 'corrupt', message: 'Plik zatwierdzen ma innego wlasciciela.' };
    }
    if ((info.mode & 0o022) !== 0) {
      return {
        state: 'corrupt',
        message: 'Plik zatwierdzen jest zapisywalny dla grupy lub innych.',
      };
    }
  }
  const read = await readTextWithin(layout.home, file, MAX_APPROVALS_BYTES);
  if (!read.ok) return { state: 'corrupt', message: read.message };
  const parsed = parseManifestYaml(read.text);
  if (!parsed.ok) return { state: 'corrupt', message: 'Plik zatwierdzen nie jest poprawnym YAML.' };
  const checked = validateApprovalsFile(parsed.value);
  if (!checked.ok) {
    const first = checked.errors[0];
    return {
      state: 'corrupt',
      message: `Plik zatwierdzen jest niepoprawny${first ? ` (${first.path}: ${first.message})` : ''}.`,
    };
  }
  if (checked.value.company !== company) {
    return { state: 'corrupt', message: 'Plik zatwierdzen nalezy do innej firmy.' };
  }
  return { state: 'ok', file: checked.value };
}

function documentOf(file: ApprovalsFile): unknown {
  return {
    apiVersion: API_VERSION,
    kind: 'Approvals',
    company: file.company,
    entries: file.entries.map((entry) => ({
      key: entry.key,
      hash: entry.hash,
      approvedAt: entry.approvedAt,
      ...(entry.version === null ? {} : { version: entry.version }),
      fields: entry.fields,
    })),
  };
}

/** Zapis tylko dokumentu, ktory przejdzie ten sam walidator co odczyt (SEC-09): inaczej plik uniewaznilby zatwierdzenia. */
export async function saveApprovals(layout: CwmLayout, file: ApprovalsFile): Promise<void> {
  const document = documentOf(file);
  const checked = validateApprovalsFile(JSON.parse(JSON.stringify(document)) as unknown);
  if (!checked.ok) {
    const first = checked.errors[0];
    throw new WriteDeniedError(
      `Zatwierdzenia nie mieszcza sie w limitach odczytu${first ? ` (${first.path}: ${first.message})` : ''}.`,
    );
  }
  const scope = homeScope(layout.home);
  await ensureScopedDirectory(scope, approvalsDir(layout));
  await writeScopedFile(scope, approvalsFile(layout, file.company), toYaml(document));
}

export interface RecordContext {
  /** Czy zasob nadal istnieje w rejestrze; wpisy zasobow, ktorych nie ma, sa usuwane. */
  readonly hasResource: (kind: ResourceKind, id: string) => boolean;
  /** Czy katalog projektu nadal istnieje; wpisy par projekt-firma bez katalogu sa usuwane. */
  readonly projectExists: (path: string) => Promise<boolean>;
}

export interface RecordResult {
  readonly file: ApprovalsFile;
  readonly pruned: readonly string[];
}

const RESOURCE_KIND_SET: ReadonlySet<string> = new Set(RESOURCE_KINDS);

async function stalePrefix(entry: ApprovalRecord, context: RecordContext): Promise<boolean> {
  const colon = entry.key.indexOf(':');
  const kind = entry.key.slice(0, colon);
  if (kind === 'project') {
    const path = (entry.fields as { path?: unknown }).path;
    return typeof path !== 'string' || !(await context.projectExists(path));
  }
  // Klucz MCP z poleceniem-sciezka ma przyrostek `@<skrot projektu>` (zatwierdzenie per projekt).
  const id = entry.key.slice(colon + 1).replace(/@[0-9a-f]{16}$/, '');
  return RESOURCE_KIND_SET.has(kind) && !context.hasResource(kind as ResourceKind, id);
}

/**
 * Dopisuje zatwierdzenia (zastepuje wpis o tym samym kluczu). Plik jest czytany ponownie i scalany
 * pod mutexem firmy tuz przed zapisem (SEC-09), wiec dwa rownolegle `cwm start` nie gubia sobie
 * wpisow. Wpisy zasobow spoza rejestru i projektow bez katalogu sa przy tym usuwane i zwracane.
 */
export async function recordApprovals(
  layout: CwmLayout,
  company: string,
  subjects: readonly ApprovalSubject[],
  context: RecordContext,
  now: Date = new Date(),
): Promise<RecordResult> {
  const root = await openRuntimeRoot(layout, company);
  const release = await acquireMutex(root);
  try {
    const loaded = await loadApprovals(layout, company);
    if (loaded.state === 'corrupt') throw new WriteDeniedError(loaded.message);
    const current = loaded.state === 'ok' ? loaded.file.entries : [];
    const replaced = current.filter((e) => !subjects.some((subject) => subject.key === e.key));
    const kept: ApprovalRecord[] = [];
    const pruned: string[] = [];
    for (const entry of replaced) {
      if (await stalePrefix(entry, context)) pruned.push(entry.key);
      else kept.push(entry);
    }
    const added: ApprovalRecord[] = subjects.map((subject) => ({
      key: subject.key,
      hash: subject.hash,
      approvedAt: now.toISOString(),
      version: subject.version,
      fields: subject.fields,
    }));
    const next: ApprovalsFile = { company, entries: [...kept, ...added] };
    await saveApprovals(layout, next);
    return { file: next, pruned };
  } finally {
    await release();
  }
}

export async function listApprovalCompanies(layout: CwmLayout): Promise<string[]> {
  const listing = await listDirectory(layout.home, approvalsDir(layout));
  if (!listing.ok) return [];
  return listing.entries
    .filter((entry) => entry.kind === 'file' && entry.name.endsWith('.yaml'))
    .map((entry) => entry.name.slice(0, -'.yaml'.length))
    .filter(isSafeSegment);
}

export interface RevokeSelector {
  readonly key?: string;
  readonly company?: string;
  readonly all?: boolean;
}

export interface RevokeOutcome {
  readonly company: string;
  readonly removed: readonly string[];
}

/** Usuwa wpisy zatwierdzen wg selektora. Zwraca firmy, w ktorych cos usunieto (do uniewaznienia profilu, APR-08). */
export async function revokeApprovals(
  layout: CwmLayout,
  selector: RevokeSelector,
): Promise<{ outcomes: RevokeOutcome[]; corrupt: string[] }> {
  const companies =
    selector.company !== undefined ? [selector.company] : await listApprovalCompanies(layout);
  const outcomes: RevokeOutcome[] = [];
  const corrupt: string[] = [];
  for (const company of companies) {
    const root: RuntimeRoot | null = await peekRuntimeRoot(layout, company);
    const release = root === null ? null : await acquireMutex(root);
    try {
      const loaded = await loadApprovals(layout, company);
      if (loaded.state === 'missing') continue;
      if (loaded.state === 'corrupt') {
        corrupt.push(company);
        continue;
      }
      const matches = (entry: ApprovalRecord): boolean =>
        selector.key === undefined || entry.key === selector.key;
      const removed = loaded.file.entries.filter(matches).map((entry) => entry.key);
      if (removed.length === 0) continue;
      await saveApprovals(layout, {
        company,
        entries: loaded.file.entries.filter((entry) => !matches(entry)),
      });
      outcomes.push({ company, removed });
    } finally {
      await release?.();
    }
  }
  return { outcomes, corrupt };
}
