import { mkdir, readFile, readlink, rm, rmdir, stat, statfs } from 'node:fs/promises';
import path from 'node:path';

import type { ItemId, RootId, ToolId } from '../../core/model/item';
import { MAX_OBJECT_BYTES } from '../../core/model/library-limits';
import { isPathInside } from '../../core/model/path-containment';
import type {
  ApplyEntryReport,
  ApplyReport,
  WritePlan,
  WritePlanEntry,
  MaterializationMode,
  RecoverabilityVerdict,
} from '../../core/model/plan';
import type { Clock } from '../../core/ports/clock';
import { systemClock } from '../../core/ports/clock';
import type { ObjectStore } from '../../core/ports/object-store';
import type { OperationLog } from '../../core/ports/operation-log';
import { STORE_FAILURE_TEXT, failureCodeOf } from '../../core/ports/store-failure';
import type { LinkCapability, WriteGate } from '../../core/ports/write-gate';
import { sha256Bytes } from '../../core/services/normalization/hash';
import {
  FsBackupStore,
  BackupError,
  type BackupAfter,
  type BackupBefore,
  type BackupItem,
} from '../store/backup';

import { AtomicWriteError, errnoCode, writeFileAtomic, type AtomicOps } from './atomic';
import { readBounded, readChecked } from './bounded-read';
import {
  chooseMaterialization,
  createLink,
  linkPointsTo,
  materializedPath,
  materializedRoot,
  readMaterialized,
  removeLink,
  sameMaterial,
  writeMaterialized,
  type LinkOps,
  type MaterialContent,
} from './link-mode';
import { lstatOrNull } from './stat';
import {
  Blocked,
  assertRootAnchored,
  assertWritableAncestor,
  checkRelPath,
  locateTarget,
  type LocatedTarget,
} from './write-path-guard';

/**
 * `WriteGate` (ADR 0012, 0015, 0016, 0028): jedyna droga zapisu do plikow, ktorych aplikacja
 * nie posiada. `probe` tylko czyta; `apply` odmawia na starcie, robi kopie jako warunek,
 * zapisuje przez `writeFileAtomic`, weryfikuje odczytem i cofa wszystko przy pierwszym bledzie.
 */

export type WriteRefusalCode =
  'approval-mismatch' | 'not-applicable' | 'not-probed' | 'plan-changed' | 'backup-failed';

/** Odmowa na starcie: nic nie zostalo zapisane. `message` jest po polsku i bez sciezek. */
export class WriteGateRefusal extends Error {
  constructor(
    readonly code: WriteRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'WriteGateRefusal';
  }
}

export interface WriteGateDeps {
  /** Wstrzykiwana mapa `rootId` -> sciezka (`FsLocationCatalog.resolvePath`); brama nie zna tabeli. */
  readonly resolveRoot: (rootId: RootId) => string | null;
  /** `userData`: tu leza `backups/`, `materialized/` i `tmp/`. */
  readonly userDataDir: string;
  readonly objects: ObjectStore;
  readonly linkMode: { capability(): Promise<LinkCapability> };
  readonly operationLog?: OperationLog;
  readonly clock?: Clock;
  readonly platform?: NodeJS.Platform;
  /** Szwy dla testow. */
  readonly atomicOps?: Partial<AtomicOps>;
  readonly linkOps?: Partial<LinkOps>;
  readonly backups?: FsBackupStore;
  readonly freeBytes?: (dir: string) => Promise<number | null>;
  /**
   * Czy root jest plikiem (CLAUDE.md, config.toml). Bez tego: pusty `relPath` albo `relPath` rowny
   * nazwie istniejacego roota-pliku; dla roota, ktorego nie ma, decyduje rozszerzenie nazwy.
   */
  readonly isFileRoot?: (rootId: RootId, rootPath: string, relPath: string) => Promise<boolean>;
}

// --- stan na dysku ---

type Existing =
  | { readonly kind: 'missing' }
  | { readonly kind: 'file'; readonly bytes: Uint8Array; readonly mode: number }
  | { readonly kind: 'symlink'; readonly linkTarget: string; readonly isDirectory: boolean };

interface FileOp {
  readonly abs: string;
  readonly rootId: RootId;
  readonly relPath: string;
  readonly before: Existing;
  readonly final: Uint8Array;
  readonly unchanged: boolean;
}

interface DirLink {
  readonly abs: string;
  readonly rootId: RootId;
  readonly relPath: string;
  readonly before: Extract<Existing, { kind: 'symlink' }>;
}

interface LinkPlan {
  readonly kind: 'file' | 'directory';
  readonly mode: 'symlink' | 'junction';
  readonly abs: string;
  readonly rootId: RootId;
  readonly relPath: string;
  readonly materialPath: string;
  readonly before: Existing;
  readonly alreadyLinked: boolean;
  readonly material: MaterialContent;
  readonly materialBefore: MaterialContent | null;
}

/** Usuniecie pliku albo dowiazania przy cofaniu operacji (ADR 0028, ADR 0019). */
interface RemovalPlan {
  readonly abs: string;
  readonly rootId: RootId;
  readonly relPath: string;
  readonly rootPath: string;
  readonly before: Exclude<Existing, { kind: 'missing' }>;
}

/** Przywrocenie dowiazania do celu zapisanego w kopii. */
interface RestorePlan {
  readonly abs: string;
  readonly rootId: RootId;
  readonly relPath: string;
  readonly linkTarget: string;
  readonly kind: 'file' | 'directory';
  readonly before: Existing;
}

interface Resolved {
  readonly entry: WritePlanEntry;
  readonly kind: 'noop' | 'files' | 'link' | 'delete' | 'restore';
  readonly removal: RemovalPlan | null;
  readonly restore: RestorePlan | null;
  readonly ops: readonly FileOp[];
  readonly dirLink: DirLink | null;
  readonly link: LinkPlan | null;
  /** Tryb, ktory zapis faktycznie uzyje; `null` dla wpisow niebedacych `link`. */
  readonly effective: MaterializationMode | null;
  /** Informacja o degradacji, dla raportu i ostrzezen planu. */
  readonly note: string | null;
}

interface EntryAnalysis {
  readonly reason: string | null;
  readonly resolved: Resolved | null;
}

const MAX_DIR_FILES = 1000;
const VALID_ACTIONS = new Set(['create', 'modify', 'link', 'unchanged', 'delete', 'restore-link']);

class VerifyError extends Error {
  constructor() {
    super('Odczyt kontrolny różni się od zapisanej treści.');
    this.name = 'VerifyError';
  }
}

// --- bajty i konce linii (ADR 0016 regula 4) ---

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.length).equals(b);
}

/** Dominujacy styl istniejacego pliku; `mixed` liczy sie jako styl przewazajacy (ADR 0016). */
function usesCrlf(bytes: Uint8Array): boolean {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0x0a) continue;
    if (i > 0 && bytes[i - 1] === 0x0d) crlf++;
    else lf++;
  }
  return crlf > 0 && crlf >= lf;
}

function toCrlf(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  let changed = false;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] as number;
    if (byte === 0x0a && (i === 0 || bytes[i - 1] !== 0x0d)) {
      out.push(0x0d);
      changed = true;
    }
    out.push(byte);
  }
  return changed ? Uint8Array.from(out) : bytes;
}

function applyTargetEol(newBytes: Uint8Array, before: Existing): Uint8Array {
  return before.kind === 'file' && usesCrlf(before.bytes) ? toCrlf(newBytes) : newBytes;
}

async function defaultFreeBytes(dir: string): Promise<number | null> {
  try {
    const info = await statfs(dir);
    return Number(info.bavail) * Number(info.bsize);
  } catch {
    return null;
  }
}

function describeFailure(error: unknown): string {
  if (error instanceof VerifyError) return error.message;
  if (error instanceof AtomicWriteError && error.reason === 'verify-failed') {
    return 'Odczyt kontrolny różni się od zapisanej treści.';
  }
  const code = failureCodeOf(error);
  return code === 'unknown'
    ? 'Błąd zapisu pliku.'
    : `Zapis nie powiódł się: ${STORE_FAILURE_TEXT[code]}.`;
}

// --- dziennik do rollbacku ---

type JournalItem =
  | {
      readonly t: 'restore-file';
      readonly abs: string;
      readonly bytes: Uint8Array;
      readonly mode: number;
    }
  | {
      readonly t: 'restore-link';
      readonly abs: string;
      readonly linkTarget: string;
      readonly isDirectory: boolean;
    }
  | { readonly t: 'remove'; readonly abs: string }
  | { readonly t: 'rmdir'; readonly abs: string }
  /** Katalog usuniety przy sprzataniu po `delete`; rollback tworzy go z powrotem. */
  | { readonly t: 'mkdir'; readonly abs: string }
  | {
      readonly t: 'material';
      readonly path: string;
      readonly before: MaterialContent | null;
    };

export class FsWriteGate implements WriteGate {
  private readonly clock: Clock;
  private readonly platform: NodeJS.Platform;
  private readonly backups: FsBackupStore;
  private readonly freeBytes: (dir: string) => Promise<number | null>;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: WriteGateDeps) {
    this.clock = deps.clock ?? systemClock;
    this.platform = deps.platform ?? process.platform;
    this.freeBytes = deps.freeBytes ?? defaultFreeBytes;
    this.backups =
      deps.backups ??
      new FsBackupStore(path.join(deps.userDataDir, 'backups'), {
        clock: this.clock,
        ...(deps.atomicOps === undefined ? {} : { atomicOps: deps.atomicOps }),
      });
  }

  // --- probe ---

  async probe(plan: WritePlan): Promise<WritePlan> {
    const analyses = await this.analyze(plan);
    const probedAt = this.clock.now().toISOString();
    const entries = plan.entries.map((entry, index): WritePlanEntry => {
      const analysis = analyses[index];
      const verdict: RecoverabilityVerdict =
        analysis === undefined || analysis.reason !== null
          ? { status: 'blocked', reason: analysis?.reason ?? 'Nie sprawdzono wpisu.', probedAt }
          : { status: 'recoverable', reason: null, probedAt };
      const resolved = analysis?.resolved ?? null;
      // Adapter nie widzi celu dowiazania ani userData, wiec to brama stwierdza, ze nic sie nie zmieni.
      const idle = entry.action === 'link' && resolved !== null && this.changesNothing(resolved);
      const warnings =
        !idle &&
        resolved?.note !== null &&
        resolved?.note !== undefined &&
        !entry.warnings.includes(resolved.note)
          ? [...entry.warnings, resolved.note]
          : entry.warnings;
      return {
        ...entry,
        action: idle ? 'unchanged' : entry.action,
        materialization: resolved?.effective ?? entry.materialization,
        warnings,
        recoverability: verdict,
      };
    });
    const applicable =
      entries.every((e) => e.recoverability?.status === 'recoverable') &&
      plan.conflicts.length === 0;
    return { ...plan, entries, applicable };
  }

  /** Link wskazuje na nasza materializacje o tej samej tresci, albo kopia ma tresc identyczna z planem. */
  private changesNothing(resolved: Resolved): boolean {
    if (resolved.kind === 'link' && resolved.link !== null) {
      return (
        resolved.link.alreadyLinked &&
        sameMaterial(resolved.link.materialBefore, resolved.link.material)
      );
    }
    return (
      resolved.kind === 'files' &&
      resolved.dirLink === null &&
      resolved.ops.length > 0 &&
      resolved.ops.every((op) => op.unchanged)
    );
  }

  // --- apply ---

  async apply(plan: WritePlan, approval: { readonly planId: string }): Promise<ApplyReport> {
    // Tylko jawne zatwierdzenie tego planu; bez niego nie ma trybu "zapisz to teraz".
    if (typeof approval?.planId !== 'string' || approval.planId !== plan.planId) {
      throw new WriteGateRefusal(
        'approval-mismatch',
        'Brak zatwierdzenia tego planu zapisu. Zapis nie został wykonany.',
      );
    }
    if (!plan.applicable || plan.conflicts.length > 0) {
      throw new WriteGateRefusal(
        'not-applicable',
        'Plan zapisu nie jest wykonywalny: ma zablokowane wpisy albo nierozstrzygnięte konflikty.',
      );
    }
    return this.serialize(() => this.applyExclusive(plan));
  }

  /** Jednobieznosc: kolejny `apply` czeka, a po swoim ponownym `probe` zobaczy zmieniony stan. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async applyExclusive(plan: WritePlan): Promise<ApplyReport> {
    const analyses = await this.analyze(plan);
    plan.entries.forEach((entry, index) => {
      const recorded = entry.recoverability;
      const now = analyses[index];
      if (recorded === null) {
        throw new WriteGateRefusal(
          'not-probed',
          'Plan nie został sprawdzony przed zapisem. Przygotuj go ponownie.',
        );
      }
      const reason = now?.reason ?? null;
      if (
        reason !== null ||
        recorded.status !== 'recoverable' ||
        now?.resolved === null ||
        now?.resolved === undefined
      ) {
        throw new WriteGateRefusal(
          'plan-changed',
          `Plan nie jest już aktualny: ${reason ?? 'wynik sprawdzenia jest inny niż przy przygotowaniu planu'}`,
        );
      }
    });
    const resolved = analyses.map((a) => a.resolved as Resolved);

    const items = this.backupItems(resolved);
    let backupId = '';
    if (items.length > 0) {
      try {
        await this.storeInObjects(items);
        ({ backupId } = await this.backups.create({ planId: plan.planId, tool: plan.tool }, items));
      } catch (error: unknown) {
        throw new WriteGateRefusal(
          'backup-failed',
          error instanceof BackupError
            ? 'Nie udało się zrobić kopii zapasowej, więc nic nie zapisano.'
            : `Nie udało się zrobić kopii zapasowej, więc nic nie zapisano. ${describeFailure(error)}`,
        );
      }
    }

    const journal: JournalItem[] = [];
    const reports: ApplyEntryReport[] = [];
    let failure: { index: number; message: string } | null = null;

    for (const [index, item] of resolved.entries()) {
      try {
        const result = await this.execute(item, journal);
        reports.push({
          rootId: item.entry.rootId,
          relPath: item.entry.relPath,
          outcome: result.changed ? 'written' : 'unchanged',
          message: result.message,
        });
      } catch (error: unknown) {
        failure = { index, message: describeFailure(error) };
        break;
      }
    }

    if (failure === null) {
      await this.logOperation(plan, backupId, resolved, reports);
      return { planId: plan.planId, backupId, entries: reports, verified: true, rolledBack: false };
    }

    const restoreErrors = await this.rollback(journal);
    const restored = restoreErrors === 0;
    const entries = plan.entries.map((entry, index): ApplyEntryReport => {
      const done = reports[index];
      const base = { rootId: entry.rootId, relPath: entry.relPath };
      if (index === failure.index) {
        return { ...base, outcome: 'failed', message: failure.message };
      }
      if (done?.outcome === 'unchanged') return done;
      if (done !== undefined) {
        return restored
          ? { ...base, outcome: 'rolled-back', message: 'Zapis cofnięto z kopii zapasowej.' }
          : {
              ...base,
              outcome: 'failed',
              message: `Nie udało się cofnąć zapisu. Pliki są w kopii zapasowej ${backupId}.`,
            };
      }
      return {
        ...base,
        outcome: 'rolled-back',
        message: 'Nie zapisano: operacja została przerwana.',
      };
    });
    return { planId: plan.planId, backupId, entries, verified: false, rolledBack: restored };
  }

  // --- analiza (wspolna dla probe i apply) ---

  private async analyze(plan: WritePlan): Promise<EntryAnalysis[]> {
    const capability = await this.deps.linkMode.capability();
    const seen = new Set<string>();
    const materialOwners = new Map<string, string>();
    const results: EntryAnalysis[] = [];
    let budget = await this.freeBytes(this.deps.userDataDir);

    for (const entry of plan.entries) {
      let analysis: EntryAnalysis;
      try {
        const resolved = await this.analyzeEntry(
          plan.tool,
          entry,
          capability,
          seen,
          materialOwners,
        );
        const need = this.spaceNeeded(resolved);
        if (budget !== null) {
          budget -= need;
          if (budget < 0) {
            throw new Blocked('W katalogu danych aplikacji brakuje miejsca na kopię zapasową.');
          }
        }
        analysis = { reason: null, resolved };
      } catch (error: unknown) {
        analysis = { reason: this.reasonOf(error), resolved: null };
      }
      results.push(analysis);
    }
    return results;
  }

  private reasonOf(error: unknown): string {
    if (error instanceof Blocked) return error.reason;
    const code = errnoCode(error);
    if (code === 'EACCES' || code === 'EPERM')
      return 'Brak dostępu do pliku lub katalogu docelowego.';
    return 'Nie udało się sprawdzić stanu pliku docelowego.';
  }

  private spaceNeeded(resolved: Resolved): number {
    let need = 0;
    if (resolved.removal?.before.kind === 'file') need += resolved.removal.before.bytes.length * 2;
    if (resolved.restore?.before.kind === 'file') need += resolved.restore.before.bytes.length * 2;
    for (const op of resolved.ops) {
      if (!op.unchanged && op.before.kind === 'file') need += op.before.bytes.length * 2;
    }
    if (resolved.link !== null) {
      const { material, before } = resolved.link;
      if (before.kind === 'file') need += before.bytes.length * 2;
      need +=
        material.kind === 'file'
          ? material.bytes.length
          : material.files.reduce((sum, f) => sum + f.bytes.length, 0);
    }
    return need;
  }

  private async analyzeEntry(
    tool: ToolId,
    entry: WritePlanEntry,
    capability: LinkCapability,
    seen: Set<string>,
    materialOwners: Map<string, string>,
  ): Promise<Resolved> {
    if (!VALID_ACTIONS.has(entry.action)) throw new Blocked('Nieznany rodzaj operacji we wpisie.');
    const rootPath = this.deps.resolveRoot(entry.rootId);
    if (rootPath === null) throw new Blocked('Nieznana lokalizacja docelowa.');
    const fileRoot = await this.isFileRoot(entry, rootPath);

    const claim = (abs: string): void => {
      const key = abs.toLowerCase();
      if (seen.has(key)) throw new Blocked('Dwa wpisy planu wskazują ten sam plik.');
      seen.add(key);
    };

    if (entry.action === 'unchanged') {
      const loc = await locateTarget(rootPath, entry.relPath, {
        platform: this.platform,
        fileRoot,
      });
      claim(loc.abs);
      return this.resolved(entry, 'noop', [], null, null, null, null);
    }

    if (entry.action === 'delete') {
      return this.analyzeDelete(entry, rootPath, fileRoot, claim);
    }
    if (entry.action === 'restore-link') {
      return this.analyzeRestoreLink(entry, rootPath, fileRoot, claim);
    }

    const hasContent = entry.content !== null;
    const hasFiles = entry.files !== null;
    if (hasContent === hasFiles) {
      throw new Blocked('Wpis musi mieć albo treść pliku, albo listę plików katalogu.');
    }
    if (hasFiles && fileRoot) {
      throw new Blocked('Lokalizacja docelowa jest plikiem, a wpis opisuje katalog.');
    }
    if (entry.content !== null && entry.content.length > MAX_OBJECT_BYTES) {
      throw new Blocked('Treść do zapisu przekracza limit rozmiaru.');
    }
    if (entry.files !== null && (entry.files.length === 0 || entry.files.length > MAX_DIR_FILES)) {
      throw new Blocked('Wpis katalogowy ma pustą albo zbyt dużą listę plików.');
    }

    await assertRootAnchored(rootPath);

    if (entry.action === 'link') {
      return this.analyzeLink(tool, entry, rootPath, fileRoot, capability, claim, materialOwners);
    }
    const { ops, dirLink } = await this.buildWriteOps(entry, rootPath, fileRoot, false, claim);
    return this.resolved(entry, 'files', ops, dirLink, null, null, null);
  }

  /** Usuniecie to cofniecie zapisu aplikacji: plik ma te tresc, jaka widzial plan, a dowiazanie jest nasze. */
  private async analyzeDelete(
    entry: WritePlanEntry,
    rootPath: string,
    fileRoot: boolean,
    claim: (abs: string) => void,
  ): Promise<Resolved> {
    if (entry.content !== null || entry.files !== null) {
      throw new Blocked('Wpis usunięcia nie może zawierać treści do zapisu.');
    }
    const loc = await locateTarget(rootPath, entry.relPath, { platform: this.platform, fileRoot });
    claim(loc.abs);
    const before = await this.snapshot(loc.abs);
    if (before.kind === 'missing') return this.resolved(entry, 'noop', [], null, null, null, null);
    if (before.kind === 'file') {
      const expected = entry.previous;
      if (expected === null || !bytesEqual(before.bytes, expected)) {
        throw new Blocked('Plik zmienił się od przygotowania planu.');
      }
    } else if (!this.isOurs(loc.abs, before.linkTarget)) {
      throw new Blocked('Dowiązanie nie pochodzi z zapisu aplikacji, więc go nie usunę.');
    }
    await assertWritableAncestor(loc.parentReal, this.platform);
    const removal: RemovalPlan = {
      abs: loc.abs,
      rootId: entry.rootId,
      relPath: entry.relPath,
      rootPath,
      before,
    };
    return { ...this.resolved(entry, 'delete', [], null, null, null, null), removal };
  }

  private async analyzeRestoreLink(
    entry: WritePlanEntry,
    rootPath: string,
    fileRoot: boolean,
    claim: (abs: string) => void,
  ): Promise<Resolved> {
    if (entry.content !== null || entry.files !== null) {
      throw new Blocked('Wpis przywrócenia dowiązania nie może zawierać treści do zapisu.');
    }
    const target = entry.linkTarget;
    if (typeof target !== 'string' || target === '' || target.includes('\0')) {
      throw new Blocked('Kopia nie podaje poprawnego celu dowiązania.');
    }
    const loc = await locateTarget(rootPath, entry.relPath, { platform: this.platform, fileRoot });
    claim(loc.abs);
    const before = await this.snapshot(loc.abs);
    if (before.kind === 'symlink' && before.linkTarget === target) {
      return this.resolved(entry, 'noop', [], null, null, null, null);
    }
    if (before.kind === 'file') {
      const expected = entry.previous;
      if (expected === null || !bytesEqual(before.bytes, expected)) {
        throw new Blocked('Plik zmienił się od przygotowania planu.');
      }
    }
    await assertWritableAncestor(loc.parentReal, this.platform);
    const resolvedTarget = path.resolve(path.dirname(loc.abs), target);
    const isDirectory = await stat(resolvedTarget).then(
      (s) => s.isDirectory(),
      () => false,
    );
    const restore: RestorePlan = {
      abs: loc.abs,
      rootId: entry.rootId,
      relPath: entry.relPath,
      linkTarget: target,
      kind: isDirectory ? 'directory' : 'file',
      before,
    };
    return { ...this.resolved(entry, 'restore', [], null, null, null, null), restore };
  }

  private resolved(
    entry: WritePlanEntry,
    kind: Resolved['kind'],
    ops: readonly FileOp[],
    dirLink: DirLink | null,
    link: LinkPlan | null,
    effective: MaterializationMode | null,
    note: string | null,
  ): Resolved {
    return { entry, kind, removal: null, restore: null, ops, dirLink, link, effective, note };
  }

  private async isFileRoot(entry: WritePlanEntry, rootPath: string): Promise<boolean> {
    if (this.deps.isFileRoot !== undefined) {
      return this.deps.isFileRoot(entry.rootId, rootPath, entry.relPath);
    }
    if (entry.relPath === '') return true;
    if (entry.relPath !== path.basename(rootPath)) return false;
    try {
      return !(await stat(rootPath)).isDirectory();
    } catch (error: unknown) {
      if (errnoCode(error) !== 'ENOENT') return false;
      // Roota nie ma: CLAUDE.md i config.toml maja rozszerzenie, katalogi skilli nie.
      return /\.[A-Za-z0-9]+$/.test(entry.relPath);
    }
  }

  /** Zapis zwyklym plikiem albo katalogiem plikow (takze kopia jako degradacja `link`). */
  private async buildWriteOps(
    entry: WritePlanEntry,
    rootPath: string,
    fileRoot: boolean,
    allowLinkReplace: boolean,
    claim: (abs: string) => void,
  ): Promise<{ ops: FileOp[]; dirLink: DirLink | null }> {
    if (entry.content !== null) {
      const loc = await locateTarget(rootPath, entry.relPath, {
        platform: this.platform,
        fileRoot,
      });
      claim(loc.abs);
      const op = await this.fileOp(entry, loc, entry.relPath, entry.content, {
        checkPrevious: true,
        allowLinkReplace,
        forceMissing: false,
      });
      return { ops: [op], dirLink: null };
    }

    const files = entry.files ?? [];
    const dirLoc = await locateTarget(rootPath, entry.relPath, {
      platform: this.platform,
      fileRoot,
    });
    const dirInfo = await lstatOrNull(dirLoc.abs);
    let dirLink: DirLink | null = null;
    if (dirInfo?.isSymbolicLink() === true) {
      const linkTarget = await readlink(dirLoc.abs);
      if (!allowLinkReplace && !this.isOurs(dirLoc.abs, linkTarget)) {
        throw new Blocked(
          'Katalog docelowy jest dowiązaniem do innego miejsca. Zapis nie podąża za cudzym dowiązaniem.',
        );
      }
      dirLink = {
        abs: dirLoc.abs,
        rootId: entry.rootId,
        relPath: entry.relPath,
        before: { kind: 'symlink', linkTarget, isDirectory: true },
      };
    } else if (dirInfo !== null && !dirInfo.isDirectory()) {
      throw new Blocked('W miejscu katalogu docelowego jest plik.');
    }

    const ops: FileOp[] = [];
    for (const file of files) {
      const reason = checkRelPath(file.relPath);
      if (reason !== null) throw new Blocked(reason);
      if (file.bytes.length > MAX_OBJECT_BYTES)
        throw new Blocked('Plik w katalogu przekracza limit rozmiaru.');
      const rel = `${entry.relPath}/${file.relPath}`;
      const loc = await locateTarget(rootPath, rel, {
        platform: this.platform,
        fileRoot: false,
        ...(dirLink === null
          ? {}
          : { assumeReplaced: { abs: dirLoc.abs, parentReal: dirLoc.parentReal } }),
      });
      claim(loc.abs);
      ops.push(
        await this.fileOp(entry, loc, rel, file.bytes, {
          checkPrevious: false,
          allowLinkReplace: false,
          forceMissing: dirLink !== null,
        }),
      );
    }
    return { ops, dirLink };
  }

  private isOurs(linkAbs: string, linkTarget: string): boolean {
    const absolute = path.resolve(path.dirname(linkAbs), linkTarget);
    return isPathInside(absolute, materializedRoot(this.deps.userDataDir));
  }

  private async fileOp(
    entry: WritePlanEntry,
    loc: LocatedTarget,
    relPath: string,
    bytes: Uint8Array,
    opts: { checkPrevious: boolean; allowLinkReplace: boolean; forceMissing: boolean },
  ): Promise<FileOp> {
    const before: Existing = opts.forceMissing ? { kind: 'missing' } : await this.snapshot(loc.abs);
    if (
      before.kind === 'symlink' &&
      !opts.allowLinkReplace &&
      !this.isOurs(loc.abs, before.linkTarget)
    ) {
      throw new Blocked(
        'Plik docelowy jest dowiązaniem. Zapis zastąpiłby je zwykłym plikiem, więc nie jest wykonywany.',
      );
    }
    if (opts.checkPrevious && before.kind !== 'symlink') {
      const actual = before.kind === 'file' ? before.bytes : null;
      const expected = entry.previous;
      const same =
        actual === null || expected === null ? actual === expected : bytesEqual(actual, expected);
      if (!same) throw new Blocked('Plik zmienił się od przygotowania planu.');
    }
    const final = applyTargetEol(bytes, before);
    const unchanged = before.kind === 'file' && bytesEqual(final, before.bytes);
    if (!unchanged) await assertWritableAncestor(loc.parentReal, this.platform);
    return { abs: loc.abs, rootId: entry.rootId, relPath, before, final, unchanged };
  }

  private async snapshot(abs: string): Promise<Existing> {
    const info = await lstatOrNull(abs);
    if (info === null) return { kind: 'missing' };
    if (info.isSymbolicLink()) {
      const linkTarget = await readlink(abs);
      const isDirectory = await stat(abs).then(
        (s) => s.isDirectory(),
        () => false,
      );
      return { kind: 'symlink', linkTarget, isDirectory };
    }
    if (!info.isFile()) {
      throw new Blocked('W miejscu pliku docelowego jest katalog albo inny wpis specjalny.');
    }
    try {
      const read = await readChecked(abs, MAX_OBJECT_BYTES, { strict: true });
      switch (read.kind) {
        case 'ok':
          return { kind: 'file', bytes: read.bytes, mode: info.mode & 0o777 };
        case 'missing':
          return { kind: 'missing' };
        case 'too-large':
          throw new Blocked('Plik docelowy przekracza limit rozmiaru kopii zapasowej.');
        default:
          throw new Blocked('Plik docelowy zmienił typ w trakcie sprawdzania.');
      }
    } catch (error: unknown) {
      if (error instanceof Blocked) throw error;
      const code = errnoCode(error);
      if (code === 'ENOENT') return { kind: 'missing' };
      if (code === 'EACCES' || code === 'EPERM') {
        throw new Blocked('Plik docelowy jest nieczytelny, więc nie da się zrobić jego kopii.');
      }
      // Windows: naruszenie wspoldzielenia (inny proces trzyma plik) libuv zwraca jako EBUSY.
      if (code === 'EBUSY') {
        throw new Blocked(
          'Plik docelowy jest otwarty przez inny program, więc nie da się zrobić jego kopii. Zamknij ten program i przygotuj plan ponownie.',
        );
      }
      throw error;
    }
  }

  private async analyzeLink(
    tool: ToolId,
    entry: WritePlanEntry,
    rootPath: string,
    fileRoot: boolean,
    capability: LinkCapability,
    claim: (abs: string) => void,
    materialOwners: Map<string, string>,
  ): Promise<Resolved> {
    const kind = entry.files !== null ? 'directory' : 'file';
    const choice = chooseMaterialization(capability, kind, entry.materialization);
    if (choice.mode === 'copy') {
      const { ops, dirLink } = await this.buildWriteOps(entry, rootPath, fileRoot, true, claim);
      return this.resolved(entry, 'files', ops, dirLink, null, 'copy', choice.degradedReason);
    }

    const loc = await locateTarget(rootPath, entry.relPath, { platform: this.platform, fileRoot });
    claim(loc.abs);

    let before: Existing;
    if (kind === 'directory') {
      const info = await lstatOrNull(loc.abs);
      if (info === null) before = { kind: 'missing' };
      else if (info.isSymbolicLink()) before = await this.snapshot(loc.abs);
      else {
        throw new Blocked(
          'W miejscu docelowym jest katalog albo plik, którego nie zastąpię dowiązaniem. Usuń go albo wybierz tryb kopii.',
        );
      }
    } else {
      before = await this.snapshot(loc.abs);
      if (before.kind === 'file') {
        const expected = entry.previous;
        if (expected === null || !bytesEqual(before.bytes, expected)) {
          throw new Blocked('Plik zmienił się od przygotowania planu.');
        }
      }
    }

    const materialKey = entry.relPath === '' ? path.basename(rootPath) : entry.relPath;
    const materialPath = materializedPath(this.deps.userDataDir, tool, materialKey);
    const owner = materialOwners.get(materialPath);
    if (owner !== undefined && owner !== loc.abs) {
      throw new Blocked('Inny wpis planu używa tej samej ścieżki materializacji.');
    }
    materialOwners.set(materialPath, loc.abs);

    let material: MaterialContent;
    if (entry.files !== null) {
      for (const file of entry.files) {
        const reason = checkRelPath(file.relPath);
        if (reason !== null) throw new Blocked(reason);
        if (file.bytes.length > MAX_OBJECT_BYTES) {
          throw new Blocked('Plik w katalogu przekracza limit rozmiaru.');
        }
      }
      material = { kind: 'directory', files: entry.files };
    } else {
      material = { kind: 'file', bytes: entry.content ?? new Uint8Array() };
    }
    const materialBefore = await readMaterialized(materialPath, kind);
    const alreadyLinked = before.kind === 'symlink' && (await linkPointsTo(loc.abs, materialPath));
    if (!alreadyLinked) await assertWritableAncestor(loc.parentReal, this.platform);

    const link: LinkPlan = {
      kind,
      mode: choice.mode === 'junction' ? 'junction' : 'symlink',
      abs: loc.abs,
      rootId: entry.rootId,
      relPath: entry.relPath,
      materialPath,
      before,
      alreadyLinked,
      material,
      materialBefore,
    };
    return this.resolved(entry, 'link', [], null, link, choice.mode, choice.degradedReason);
  }

  // --- kopia ---

  private backupItems(resolved: readonly Resolved[]): BackupItem[] {
    const items: BackupItem[] = [];
    const toBefore = (existing: Existing): BackupBefore => {
      if (existing.kind === 'file')
        return { state: 'file', bytes: existing.bytes, mode: existing.mode };
      if (existing.kind === 'symlink') return { state: 'symlink', linkTarget: existing.linkTarget };
      return { state: 'missing' };
    };
    for (const item of resolved) {
      const action = item.entry.action;
      if (item.removal !== null) {
        items.push({
          rootId: item.removal.rootId,
          relPath: item.removal.relPath,
          path: item.removal.abs,
          action,
          before: toBefore(item.removal.before),
          after: { state: 'missing' },
        });
      }
      if (item.restore !== null) {
        items.push({
          rootId: item.restore.rootId,
          relPath: item.restore.relPath,
          path: item.restore.abs,
          action,
          before: toBefore(item.restore.before),
          after: { state: 'symlink', linkTarget: item.restore.linkTarget },
        });
      }
      if (item.dirLink !== null) {
        items.push({
          rootId: item.dirLink.rootId,
          relPath: item.dirLink.relPath,
          path: item.dirLink.abs,
          action,
          before: toBefore(item.dirLink.before),
          after: { state: 'directory' },
        });
      }
      for (const op of item.ops) {
        if (op.unchanged) continue;
        items.push({
          rootId: op.rootId,
          relPath: op.relPath,
          path: op.abs,
          action,
          before: toBefore(op.before),
          after: { state: 'file', bytes: op.final },
        });
      }
      const link = item.link;
      if (link !== null && !link.alreadyLinked) {
        const after: BackupAfter = { state: 'symlink', linkTarget: link.materialPath };
        items.push({
          rootId: link.rootId,
          relPath: link.relPath,
          path: link.abs,
          action,
          before: toBefore(link.before),
          after,
        });
      }
    }
    return items;
  }

  /** Content store (ADR 0019) jest zrodlem rollbacku; kopia musi byc czytelna z powrotem, zanim cokolwiek zapiszemy. */
  private async storeInObjects(items: readonly BackupItem[]): Promise<void> {
    for (const item of items) {
      if (item.before.state !== 'file') continue;
      const hash = await this.deps.objects.put(item.before.bytes);
      if (hash !== sha256Bytes(item.before.bytes) || (await this.deps.objects.get(hash)) === null) {
        throw new BackupError('Kopia w content store jest nieczytelna.');
      }
    }
  }

  // --- wykonanie ---

  private async execute(
    item: Resolved,
    journal: JournalItem[],
  ): Promise<{ changed: boolean; message: string | null }> {
    if (item.kind === 'noop') return { changed: false, message: null };
    if (item.kind === 'delete') {
      await this.executeDelete(item.removal as RemovalPlan, journal);
      return { changed: true, message: null };
    }
    if (item.kind === 'restore') {
      await this.executeRestore(item.restore as RestorePlan, journal);
      return { changed: true, message: null };
    }
    if (item.kind === 'files') {
      const changed = await this.executeFiles(item, journal);
      return { changed, message: changed ? item.note : null };
    }
    return this.executeLink(item, journal);
  }

  private async executeFiles(item: Resolved, journal: JournalItem[]): Promise<boolean> {
    let changed = false;
    if (item.dirLink !== null && item.ops.some((op) => !op.unchanged)) {
      journal.push(this.restoreOf(item.dirLink.abs, item.dirLink.before));
      await removeLink(item.dirLink.abs);
      changed = true;
    }
    for (const op of item.ops) {
      if (op.unchanged) continue;
      await this.writeOp(op, journal);
      changed = true;
    }
    return changed;
  }

  private async executeDelete(removal: RemovalPlan, journal: JournalItem[]): Promise<void> {
    journal.push(this.restoreOf(removal.abs, removal.before));
    if (removal.before.kind === 'symlink') await removeLink(removal.abs);
    else await rm(removal.abs, { force: true });
    if ((await lstatOrNull(removal.abs)) !== null) throw new VerifyError();

    // Katalogi, ktore opustoszaly po usunieciu, znikaja do roota (wylacznie puste: rmdir nie usuwa pelnych).
    let dir = path.dirname(removal.abs);
    while (dir !== removal.rootPath && isPathInside(dir, removal.rootPath)) {
      try {
        await rmdir(dir);
      } catch {
        break;
      }
      journal.push({ t: 'mkdir', abs: dir });
      dir = path.dirname(dir);
    }
  }

  private async executeRestore(restore: RestorePlan, journal: JournalItem[]): Promise<void> {
    await this.mkdirTracked(path.dirname(restore.abs), journal);
    journal.push(this.restoreOf(restore.abs, restore.before));
    await createLink(restore.linkTarget, restore.abs, restore.kind, 'symlink', {
      platform: this.platform,
      ...(this.deps.linkOps === undefined ? {} : { ops: this.deps.linkOps }),
    });
    if ((await readlink(restore.abs)) !== restore.linkTarget) throw new VerifyError();
  }

  private restoreOf(abs: string, before: Existing): JournalItem {
    if (before.kind === 'file')
      return { t: 'restore-file', abs, bytes: before.bytes, mode: before.mode };
    if (before.kind === 'symlink') {
      return {
        t: 'restore-link',
        abs,
        linkTarget: before.linkTarget,
        isDirectory: before.isDirectory,
      };
    }
    return { t: 'remove', abs };
  }

  private async writeOp(op: FileOp, journal: JournalItem[]): Promise<void> {
    await this.mkdirTracked(path.dirname(op.abs), journal);
    journal.push(this.restoreOf(op.abs, op.before));
    await writeFileAtomic(op.abs, op.final, {
      ...(op.before.kind === 'file' ? { mode: op.before.mode } : {}),
      ...(this.deps.atomicOps === undefined ? {} : { ops: this.deps.atomicOps }),
    });
    await this.verifyFile(op.abs, op.final);
  }

  private async verifyFile(abs: string, expected: Uint8Array): Promise<void> {
    const back = await readBounded(abs, MAX_OBJECT_BYTES);
    if (back.truncated || !bytesEqual(back.bytes, expected)) throw new VerifyError();
  }

  /** Tworzy brakujace katalogi i zapisuje w dzienniku tylko te, ktore powstaly, zeby rollback zostawil drzewo jak bylo. */
  private async mkdirTracked(dir: string, journal: JournalItem[]): Promise<void> {
    const missing: string[] = [];
    let current = dir;
    for (;;) {
      if ((await lstatOrNull(current)) !== null) break;
      missing.unshift(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const created of missing) {
      journal.push({ t: 'rmdir', abs: created });
      await mkdir(created, { mode: 0o700 });
    }
  }

  private async executeLink(
    item: Resolved,
    journal: JournalItem[],
  ): Promise<{ changed: boolean; message: string | null }> {
    const link = item.link as LinkPlan;
    journal.push({ t: 'material', path: link.materialPath, before: link.materialBefore });
    await writeMaterialized(link.materialPath, link.material);
    const materialChanged = !sameMaterial(link.materialBefore, link.material);

    if (link.alreadyLinked) {
      await this.verifyThroughLink(link);
      return { changed: materialChanged, message: null };
    }

    await this.mkdirTracked(path.dirname(link.abs), journal);
    journal.push(this.restoreOf(link.abs, link.before));
    try {
      await createLink(link.materialPath, link.abs, link.kind, link.mode, {
        platform: this.platform,
        ...(this.deps.linkOps === undefined ? {} : { ops: this.deps.linkOps }),
      });
      await this.verifyThroughLink(link);
      return { changed: true, message: item.note };
    } catch (error: unknown) {
      const cause = failureCodeOf(error);
      const why =
        cause === 'unknown' ? 'system odmówił utworzenia dowiązania' : STORE_FAILURE_TEXT[cause];
      await this.copyInstead(link, journal);
      return {
        changed: true,
        message: `Dowiązanie nie powstało (${why}), więc zapisano kopię. Zmiany w bibliotece wymagają ponownej synchronizacji.`,
      };
    }
  }

  /** Odczyt przez dowiazanie: `readBounded` odmawia symlinkow (O_NOFOLLOW), a tu wlasnie one maja dzialac. */
  private async verifyThroughLink(link: LinkPlan): Promise<void> {
    const check = async (abs: string, expected: Uint8Array): Promise<void> => {
      if (!bytesEqual(await readFile(abs), expected)) throw new VerifyError();
    };
    if (link.material.kind === 'file') {
      await check(link.abs, link.material.bytes);
      return;
    }
    for (const file of link.material.files) {
      await check(path.join(link.abs, ...file.relPath.split('/')), file.bytes);
    }
  }

  /** Awaryjna kopia po nieudanym dowiazaniu. Dziennik juz zawiera przywrocenie poprzedniego stanu celu. */
  private async copyInstead(link: LinkPlan, journal: JournalItem[]): Promise<void> {
    const atomic = this.deps.atomicOps === undefined ? {} : { ops: this.deps.atomicOps };
    if (link.material.kind === 'file') {
      const final = applyTargetEol(link.material.bytes, link.before);
      await writeFileAtomic(link.abs, final, {
        ...(link.before.kind === 'file' ? { mode: link.before.mode } : {}),
        ...atomic,
      });
      await this.verifyFile(link.abs, final);
      return;
    }
    const info = await lstatOrNull(link.abs);
    if (info?.isSymbolicLink() === true) await removeLink(link.abs);
    await this.mkdirTracked(link.abs, journal);
    for (const file of link.material.files) {
      const target = path.join(link.abs, ...file.relPath.split('/'));
      await this.mkdirTracked(path.dirname(target), journal);
      journal.push({ t: 'remove', abs: target });
      await writeFileAtomic(target, file.bytes, atomic);
      await this.verifyFile(target, file.bytes);
    }
  }

  // --- rollback ---

  /** Zwraca liczbe krokow, ktorych nie udalo sie cofnac. Idzie do konca mimo bledow. */
  private async rollback(journal: readonly JournalItem[]): Promise<number> {
    let failures = 0;
    const atomic = this.deps.atomicOps === undefined ? {} : { ops: this.deps.atomicOps };
    for (const item of [...journal].reverse()) {
      try {
        switch (item.t) {
          case 'restore-file': {
            const bytes = await this.fromBackup(item.bytes);
            const current = await lstatOrNull(item.abs);
            if (current?.isSymbolicLink() === true) await removeLink(item.abs);
            await writeFileAtomic(item.abs, bytes, { mode: item.mode, ...atomic });
            break;
          }
          case 'restore-link': {
            const current = await lstatOrNull(item.abs);
            if (current?.isSymbolicLink() === true) await removeLink(item.abs);
            else if (current?.isFile() === true) await rm(item.abs, { force: true });
            await this.recreateLink(item);
            break;
          }
          case 'remove': {
            const current = await lstatOrNull(item.abs);
            if (current?.isSymbolicLink() === true) await removeLink(item.abs);
            else if (current !== null) await rm(item.abs, { force: true });
            break;
          }
          case 'rmdir':
            await rmdir(item.abs).catch(() => undefined);
            break;
          case 'mkdir':
            await mkdir(item.abs, { recursive: true, mode: 0o700 });
            break;
          case 'material':
            await writeMaterialized(item.path, item.before);
            break;
        }
      } catch {
        failures++;
      }
    }
    return failures;
  }

  /** Rollback czyta z content store; kopia w pamieci to tylko zabezpieczenie, gdyby store zawiodl. */
  private async fromBackup(bytes: Uint8Array): Promise<Uint8Array> {
    try {
      return (await this.deps.objects.get(sha256Bytes(bytes))) ?? bytes;
    } catch {
      return bytes;
    }
  }

  private async recreateLink(item: Extract<JournalItem, { t: 'restore-link' }>): Promise<void> {
    const kind = item.isDirectory ? 'directory' : 'file';
    const options = {
      platform: this.platform,
      ...(this.deps.linkOps === undefined ? {} : { ops: this.deps.linkOps }),
    };
    try {
      await createLink(item.linkTarget, item.abs, kind, 'symlink', options);
    } catch (error: unknown) {
      if (this.platform !== 'win32' || !item.isDirectory) throw error;
      await createLink(item.linkTarget, item.abs, kind, 'junction', options);
    }
  }

  // --- log operacji ---

  private async logOperation(
    plan: WritePlan,
    backupId: string,
    resolved: readonly Resolved[],
    reports: readonly ApplyEntryReport[],
  ): Promise<void> {
    const log = this.deps.operationLog;
    if (log === undefined) return;
    const ids = new Set<ItemId>();
    resolved.forEach((item, index) => {
      if (reports[index]?.outcome === 'written') item.entry.itemIds.forEach((id) => ids.add(id));
    });
    const at = this.clock.now().toISOString();
    for (const itemId of ids) {
      // Wpis logu jest pomocniczy: nieudany zapis nie moze cofac juz zweryfikowanego eksportu.
      await log
        .append({
          operation: plan.reverts === undefined ? 'export' : 'rollback',
          itemId,
          itemKind: null,
          slug: null,
          at,
          before: null,
          after: null,
          tool: plan.tool,
          ...(backupId === '' ? {} : { backupId }),
          ...(plan.reverts === undefined ? {} : { reverts: plan.reverts }),
        })
        .catch(() => undefined);
    }
  }
}
