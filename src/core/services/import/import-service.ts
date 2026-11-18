import type {
  GitOrigin,
  ItemDraft,
  ItemKind,
  LibraryItem,
  SecretFinding,
  Sha256,
  ToolId,
} from '../../model/item';
import { LibraryError } from '../../model/library-errors';
import type { Clock } from '../../ports/clock';
import { cryptoRandomBytes } from '../../ports/id-generator';
import type {
  DetectedRoot,
  ImportCandidate,
  ImportSkip,
  LocationCatalog,
  RootScan,
  ToolAdapter,
} from '../../ports/tool-adapter';
import type { GitSourceFailure, GitSourceProvider, GitSourceRequest } from '../../ports/git-source';
import type { SourceReader } from '../../ports/source-reader';
import type { LibraryService } from '../library/library-service';
import { validateSlug } from '../library/validate';
import { gitRefProblem, gitUrlProblem } from '../../cwm/git-source';
import { gitRefInputProblem, gitUrlInputProblem } from './git-input';
import { reviewGitCandidate } from './git-risk';
import { sha256Bytes, sha256Text } from '../normalization/hash';
import { normalizeToLf } from '../normalization/line-endings';
import {
  classifySecrets,
  classifyStructured,
  type SecretHit,
  type SecretScanFile,
} from '../security/secret-classifier';

/**
 * Serwis importu (ARCHITECTURE 3.4). Czyta zrodlo wylacznie przez adapter i `SourceReader`, nic
 * nie wykonuje i nic w zrodle nie zmienia. Kandydaci zyja tylko tutaj, w main: renderer dostaje
 * `scanToken` i identyfikatory, a `apply` dziala wylacznie na tym, co zwrocil skan.
 */

export type CandidateStatus = 'new' | 'unchanged' | 'changed' | 'duplicate' | 'conflict';

export interface ScannedCandidate {
  readonly candidateId: string;
  readonly candidate: ImportCandidate;
  readonly rootLabel: string;
  readonly status: CandidateStatus;
  /** Element biblioteki dla `unchanged`, `changed` i kolizji z biblioteka. */
  readonly existingItemId: string | null;
  /** Dla `duplicate`: kandydat, ktory narzedzie faktycznie czyta. */
  readonly duplicateOf: string | null;
  readonly secrets: readonly SecretHit[];
  readonly selectedByDefault: boolean;
  /** Pola wykonawcze usuniete z elementu z repozytorium Git przy imporcie (ADR 0058); puste dla importu lokalnego. */
  readonly dropped: readonly string[];
}

export interface ScannedSkip extends ImportSkip {
  readonly rootLabel: string;
}

export interface LibrarySlug {
  readonly kind: ItemKind;
  readonly slug: string;
}

export interface ScanReport {
  /** Repozytorium, z ktorego pochodzi skan; `null` dla skanu lokalizacji narzedzi. */
  readonly git: (GitOrigin & { readonly submodules: number }) | null;
  readonly scanToken: string;
  readonly candidates: readonly ScannedCandidate[];
  readonly skipped: readonly ScannedSkip[];
  /** Zajete nazwy w bibliotece w chwili skanu: kreator waliduje na nich nowy slug na zywo. */
  readonly librarySlugs: readonly LibrarySlug[];
}

export interface ApplyRequest {
  readonly scanToken: string;
  readonly candidateIds: readonly string[];
  readonly confirmedSecrets?: readonly string[];
  readonly replaceChanged?: readonly string[];
  /**
   * `candidateId` na nowy slug, tylko dla `conflict` (ADR 0017, addendum). Kazda nazwa jest
   * walidowana tu od nowa, bo renderer nie jest zrodlem prawdy.
   */
  readonly renames?: Readonly<Record<string, string>>;
}

export interface ApplyReport {
  readonly imported: readonly {
    candidateId: string;
    itemId: string;
    action: 'created' | 'updated';
  }[];
  readonly skipped: readonly { candidateId: string; reason: ApplySkipReason }[];
  readonly failed: readonly { candidateId: string; code: string; message: string }[];
}

export type ApplySkipReason =
  | 'unknown-candidate'
  | 'duplicate'
  | 'unchanged'
  | 'conflict'
  | 'changed-not-replaced'
  | 'secrets-not-confirmed'
  | 'slug-taken-in-this-import'
  | 'rename-not-allowed';

export type ImportErrorCode =
  'unknown-root' | 'unknown-scan' | 'git-unavailable' | 'git-rejected' | 'git-failed' | 'git-busy';

const GIT_ERROR_CODE: Readonly<Record<GitSourceFailure, ImportErrorCode>> = {
  'git-unavailable': 'git-unavailable',
  rejected: 'git-rejected',
  'fetch-failed': 'git-failed',
};

export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

export interface ImportServiceDeps {
  readonly catalog: LocationCatalog;
  readonly adapters: readonly ToolAdapter[];
  readonly reader: SourceReader;
  /** Pobieranie z repozytorium Git (ADR 0058). Brak portu to `git-unavailable`: funkcja jest opcjonalna. */
  readonly git?: GitSourceProvider;
  /**
   * Tylko testy: dopuszcza adres http na petli zwrotnej. Domyslnie `scanGit` przyjmuje wylacznie publiczny
   * adres https, niezaleznie od tego, kto go wola (ADR 0058).
   */
  readonly allowLoopbackHttpForTests?: boolean;
  readonly library: Pick<LibraryService, 'list' | 'create' | 'update'>;
  readonly clock: Clock;
  readonly ttlMs?: number;
  readonly newToken?: () => string;
  /** Szew na log bledow nieoczekiwanych; komunikat dla uzytkownika jest zawsze ogolny. */
  readonly onUnexpected?: (error: unknown) => void;
}

export const SCAN_TTL_MS = 30 * 60 * 1000;
const MAX_SCAN_SESSIONS = 8;
const GENERIC_FAILURE = 'Nie udało się zapisać elementu. Szczegóły są w logu aplikacji.';

interface RawCandidate {
  readonly candidate: ImportCandidate;
  readonly rootLabel: string;
  readonly secrets: SecretHit[];
  readonly dropped: readonly string[];
}

interface ScanSession {
  /** Pochodzenie z repozytorium Git; trafia do `importedFrom.git` i do notatki w historii. */
  readonly git: GitOrigin | null;
  readonly expiresAt: number;
  readonly candidates: Map<string, ScannedCandidate>;
}

function defaultToken(): string {
  return Array.from(cryptoRandomBytes(24), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Klucze posortowane, zeby kolejnosc pol w zrodle nie robila z identycznych danych roznicy. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Ta sama tresc to ten sam hash body (po normalizacji do LF, jak w bibliotece) i te same
 * metadane. Pola, ktorych szkic nie podaje (`attributes`, `assets`), nie licza sie jako roznica:
 * `update` zachowuje wtedy dotychczasowe, a porownanie nie moze widziec zmiany, ktorej nie bedzie.
 */
export function sameContent(draft: ItemDraft, existing: LibraryItem): boolean {
  const bodyHash: Sha256 = sha256Text(normalizeToLf(draft.content.body));
  if (bodyHash !== existing.version.contentHash) return false;

  const meta = (c: ItemDraft['content'], declaredName: string | null, aliases: readonly string[]) =>
    stableJson({
      title: c.title,
      description: c.description,
      descriptionOrigin: c.descriptionOrigin,
      declaredName,
      aliases,
    });
  const candidateMeta = meta(draft.content, draft.identity.declaredName, draft.identity.aliases);
  const existingMeta = meta(
    existing.content,
    existing.identity.declaredName,
    existing.identity.aliases,
  );
  if (candidateMeta !== existingMeta) return false;

  if (
    draft.attributes !== undefined &&
    stableJson(draft.attributes) !== stableJson(existing.attributes)
  ) {
    return false;
  }
  if (draft.assets !== undefined) {
    const wanted = draft.assets.map((a) => `${a.relPath}\0${sha256Bytes(a.bytes)}`).sort();
    const have = existing.assets.map((a) => `${a.relPath}\0${a.bytesHash}`).sort();
    if (stableJson(wanted) !== stableJson(have)) return false;
  }
  return true;
}

/** `declaredName` nie niesie osobnej informacji: brak albo ta sama nazwa co slug (wielkosc liter pomijana). */
export function followsSlug(identity: {
  readonly slug: string;
  readonly declaredName: string | null;
}): boolean {
  return (
    identity.declaredName === null ||
    identity.declaredName === '' ||
    identity.declaredName.toLowerCase() === identity.slug.toLowerCase()
  );
}

function slugKey(kind: ItemKind, slug: string): string {
  return `${kind}\0${slug.toLowerCase()}`;
}

/**
 * Walidacja nowego sluga kandydata z konfliktem, te same reguly co walidator biblioteki
 * (ADR 0017): ASCII, dlugosc, nazwy zastrzezone, brak kolizji `lower(slug)` z biblioteka
 * i z innymi kandydatami tej samej partii.
 */
function renameProblem(
  kind: ItemKind,
  slug: string,
  libraryKeys: ReadonlySet<string>,
  claimed: ReadonlySet<string>,
  taken: ReadonlySet<string>,
): { code: string; message: string } | null {
  const invalid = validateSlug(slug);
  if (invalid !== null) return { code: invalid.reason, message: invalid.message };
  const key = slugKey(kind, slug);
  if (libraryKeys.has(key)) {
    return {
      code: 'slug-collision',
      message: `Element tego typu o nazwie "${slug}" już istnieje w bibliotece (wielkość liter nie ma znaczenia). Wybierz inną nazwę.`,
    };
  }
  if (claimed.has(key) || taken.has(key)) {
    return {
      code: 'slug-collision',
      message: `Nazwa "${slug}" jest już zajęta przez inny element w tym imporcie (wielkość liter nie ma znaczenia). Wybierz inną nazwę.`,
    };
  }
  return null;
}

function baseName(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf('/') + 1);
}

/** Klasyfikator sekretow dla kandydata; wspolny z przyjmowaniem zmian z narzedzia (Etap 5). */
export function classifyCandidate(candidate: ImportCandidate): SecretHit[] {
  const { draft } = candidate;
  const files: SecretScanFile[] = [];
  const hits: SecretHit[] = [];
  for (const snapshot of draft.source?.snapshots ?? []) {
    for (const file of snapshot.files) files.push({ relPath: file.relPath, bytes: file.bytes });
    hits.push(
      ...classifyStructured(snapshot.files[0]?.relPath ?? candidate.relPath, snapshot.unmappedKeys),
    );
  }
  for (const asset of draft.assets ?? []) {
    files.push({ relPath: asset.relPath, bytes: asset.bytes });
  }
  if (files.length === 0) {
    files.push({
      relPath: baseName(candidate.relPath),
      bytes: new TextEncoder().encode(draft.content.body),
    });
  }
  return [...classifySecrets(files), ...hits];
}

export class ImportService {
  private readonly sessions = new Map<string, ScanSession>();
  private readonly adapters: ReadonlyMap<ToolId, ToolAdapter>;
  private readonly ttlMs: number;
  private readonly newToken: () => string;
  /** Jedno pobieranie naraz: katalog roboczy jest wspolny, a siec i dysk nie maja byc obciazane rownolegle. */
  private gitBusy = false;

  constructor(private readonly deps: ImportServiceDeps) {
    this.adapters = new Map(deps.adapters.map((a) => [a.id, a]));
    this.ttlMs = deps.ttlMs ?? SCAN_TTL_MS;
    this.newToken = deps.newToken ?? defaultToken;
  }

  /** Zamykanie aplikacji: przerywa trwajace pobieranie z repozytorium Git. */
  abortGit(): void {
    this.deps.git?.abort?.();
  }

  detect(): Promise<readonly DetectedRoot[]> {
    return this.deps.catalog.detect();
  }

  async scan(rootIds: readonly string[]): Promise<ScanReport> {
    const detected = await this.deps.catalog.detect();
    const wanted = [...new Set(rootIds)];
    const roots = wanted.map((id) => {
      const root = detected.find((r) => r.rootId === id);
      if (root === undefined) {
        throw new ImportError(
          'unknown-root',
          'Nieznana lokalizacja. Wykryj lokalizacje jeszcze raz.',
        );
      }
      return root;
    });
    // Kolejnosc wykrywania jest kolejnoscia pierwszenstwa rootow przy duplikatach (ADR 0024).
    roots.sort((a, b) => detected.indexOf(a) - detected.indexOf(b));
    return this.scanRoots(roots, this.deps.reader, null, 0);
  }

  /**
   * Skan repozytorium Git (ADR 0058). Port pobiera i weryfikuje kopie, tu idzie ten sam skan co dla
   * lokalizacji narzedzi, na tych samych adapterach, a kopia znika po skanie: kandydaci zyja w pamieci,
   * `apply` nie siega do dysku.
   */
  async scanGit(request: GitSourceRequest): Promise<ScanReport> {
    const provider = this.deps.git;
    if (provider === undefined) {
      throw new ImportError(
        'git-unavailable',
        'Import z repozytorium Git jest niedostępny w tej instalacji.',
      );
    }
    const problem =
      this.deps.allowLoopbackHttpForTests === true
        ? (gitUrlProblem(request.url) ?? (request.ref === null ? null : gitRefProblem(request.ref)))
        : (gitUrlInputProblem(request.url) ??
          (request.ref === null ? null : gitRefInputProblem(request.ref)));
    if (problem !== null) throw new ImportError('git-rejected', problem);
    if (this.gitBusy) {
      throw new ImportError('git-busy', 'Trwa już pobieranie repozytorium. Poczekaj na wynik.');
    }
    this.gitBusy = true;
    try {
      const opened = await provider.open(request);
      if (!opened.ok) throw new ImportError(GIT_ERROR_CODE[opened.code], opened.message);
      const { source } = opened;
      try {
        return await this.scanRoots(
          source.roots,
          source.reader,
          source.origin,
          source.submodules.length,
        );
      } finally {
        await source.release().catch((error: unknown) => this.deps.onUnexpected?.(error));
      }
    } finally {
      this.gitBusy = false;
    }
  }

  private async scanRoots(
    roots: readonly DetectedRoot[],
    reader: SourceReader,
    git: GitOrigin | null,
    submodules: number,
  ): Promise<ScanReport> {
    const raw: RawCandidate[] = [];
    const skipped: ScannedSkip[] = [];
    const scans: RootScan[] = [];

    for (const root of roots) {
      const adapter = this.adapters.get(root.tool);
      const skip = (reason: ImportSkip['reason'], message: string): void => {
        skipped.push({
          tool: root.tool,
          rootId: root.rootId,
          rootLabel: root.label,
          relPath: '',
          reason,
          message,
        });
      };
      if (adapter === undefined || !adapter.rootKinds.includes(root.kind)) {
        skip('unsupported', `Ten rodzaj lokalizacji (${root.label}) nie jest jeszcze obsługiwany.`);
        continue;
      }
      if (!root.exists) {
        skip('unreadable', `Lokalizacja ${root.label} nie istnieje.`);
        continue;
      }
      try {
        scans.push({ root, result: await adapter.scan(root, reader) });
      } catch (error: unknown) {
        this.deps.onUnexpected?.(error);
        skip('unreadable', `Nie udało się przeskanować lokalizacji ${root.label}.`);
      }
    }

    for (const done of await this.finalizeScans(scans, reader)) {
      for (const found of done.result.candidates) {
        if (git === null) {
          raw.push({
            candidate: found,
            rootLabel: done.root.label,
            secrets: this.classify(found),
            dropped: [],
          });
          continue;
        }
        // Cudze repozytorium: pola wykonawcze usuwamy albo element pomijamy, zanim ktokolwiek je zobaczy.
        const review = reviewGitCandidate(found);
        if (review.candidate === null) {
          skipped.push({
            tool: found.tool,
            rootId: found.rootId,
            rootLabel: done.root.label,
            relPath: found.relPath,
            reason: 'unsupported',
            message: review.rejection ?? 'Element z repozytorium nie jest importowany.',
          });
          continue;
        }
        raw.push({
          candidate: review.candidate,
          rootLabel: done.root.label,
          secrets: this.classify(review.candidate),
          dropped: review.dropped,
        });
      }
      for (const s of done.result.skipped) skipped.push({ ...s, rootLabel: done.root.label });
    }

    const library = (await this.deps.library.list()).items;
    const candidates = this.resolveStatuses(raw, library, git !== null);
    const scanToken = this.remember(candidates, git);
    const librarySlugs = library.map((item) => ({ kind: item.kind, slug: item.identity.slug }));
    return {
      git: git === null ? null : { ...git, submodules },
      scanToken,
      candidates,
      skipped,
      librarySlugs,
    };
  }

  /** Krok `finalize` adaptera po skanie rootow jednego narzedzia; blad adaptera nie psuje reszty. */
  private async finalizeScans(
    scans: readonly RootScan[],
    reader: SourceReader,
  ): Promise<readonly RootScan[]> {
    const out = [...scans];
    for (const tool of new Set(scans.map((s) => s.root.tool))) {
      const adapter = this.adapters.get(tool);
      if (adapter?.finalize === undefined) continue;
      const mine = scans.filter((s) => s.root.tool === tool);
      try {
        const results = await adapter.finalize(mine, reader);
        if (results.length !== mine.length) continue;
        mine.forEach((scan, i) => {
          const at = out.indexOf(scan);
          const result = results[i];
          if (at !== -1 && result !== undefined) out[at] = { root: scan.root, result };
        });
      } catch (error: unknown) {
        this.deps.onUnexpected?.(error);
      }
    }
    return out;
  }

  private remember(candidates: readonly ScannedCandidate[], git: GitOrigin | null): string {
    const now = this.deps.clock.now().getTime();
    this.purge(now);
    while (this.sessions.size >= MAX_SCAN_SESSIONS) {
      const oldest = this.sessions.keys().next();
      if (oldest.done === true) break;
      this.sessions.delete(oldest.value);
    }
    const token = this.newToken();
    this.sessions.set(token, {
      git,
      expiresAt: now + this.ttlMs,
      candidates: new Map(candidates.map((c) => [c.candidateId, c])),
    });
    return token;
  }

  private purge(now: number): void {
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }

  private classify(candidate: ImportCandidate): SecretHit[] {
    return classifyCandidate(candidate);
  }

  private resolveStatuses(
    raw: readonly RawCandidate[],
    library: readonly LibraryItem[],
    fromGit: boolean,
  ): ScannedCandidate[] {
    const ids = raw.map((_, i) => `cand-${i + 1}`);
    const status: CandidateStatus[] = raw.map(() => 'new');
    const existing: (string | null)[] = raw.map(() => null);
    const duplicateOf: (string | null)[] = raw.map(() => null);
    const decided = new Set<number>();

    const markDuplicate = (index: number, primary: number): void => {
      status[index] = 'duplicate';
      duplicateOf[index] = ids[primary] ?? null;
      decided.add(index);
    };

    // 1. Ten sam plik pod dwiema nazwami (alias, ADR 0026): pierwszy w kolejnosci skanu jest zrodlem.
    const byAlias = new Map<string, number>();
    raw.forEach(({ candidate }, i) => {
      if (candidate.aliasKey === null) return;
      const primary = byAlias.get(candidate.aliasKey);
      if (primary === undefined) byAlias.set(candidate.aliasKey, i);
      else markDuplicate(i, primary);
    });

    // 2. Ten sam slug w dwoch rootach jednego narzedzia: aktywny jest root wyzej w kolejnosci (ADR 0024).
    const bySlug = new Map<string, number>();
    raw.forEach(({ candidate }, i) => {
      if (decided.has(i)) return;
      const key = `${candidate.tool}\0${candidate.kind}\0${candidate.draft.identity.slug}`;
      const primary = bySlug.get(key);
      if (primary === undefined) {
        bySlug.set(key, i);
        return;
      }
      if (raw[primary]?.candidate.rootId !== candidate.rootId) markDuplicate(i, primary);
    });

    // 3. Reszta wzgledem skanu i biblioteki.
    const exact = new Map<string, LibraryItem>();
    const lowered = new Map<string, LibraryItem>();
    for (const item of library) {
      exact.set(`${item.kind}\0${item.identity.slug}`, item);
      lowered.set(`${item.kind}\0${item.identity.slug.toLowerCase()}`, item);
    }
    const primaryOf = new Map<string, number>();
    const bodyHash = (i: number): Sha256 =>
      sha256Text(normalizeToLf(raw[i]?.candidate.draft.content.body ?? ''));
    raw.forEach(({ candidate }, i) => {
      if (decided.has(i)) return;
      const { kind, draft } = candidate;
      const lowerKey = `${kind}\0${draft.identity.slug.toLowerCase()}`;
      const primary = primaryOf.get(lowerKey);
      if (primary !== undefined) {
        // Kolizja w obrebie skanu: pierwszy wg kolejnosci rootow jest glowny i tylko on idzie do biblioteki.
        const primaryDraft = raw[primary]?.candidate.draft;
        const sameElement =
          primaryDraft?.identity.slug === draft.identity.slug && bodyHash(primary) === bodyHash(i);
        if (sameElement) {
          markDuplicate(i, primary);
        } else {
          status[i] = 'conflict';
          duplicateOf[i] = ids[primary] ?? null;
        }
        return;
      }
      primaryOf.set(lowerKey, i);

      const same = exact.get(`${kind}\0${draft.identity.slug}`);
      if (same !== undefined) {
        existing[i] = same.id;
        status[i] = sameContent(draft, same) ? 'unchanged' : 'changed';
        return;
      }
      const clash = lowered.get(lowerKey);
      if (clash !== undefined) {
        existing[i] = clash.id;
        status[i] = 'conflict';
      }
    });

    return raw.map(({ candidate, rootLabel, secrets, dropped }, i) => {
      const st = status[i] ?? 'new';
      return {
        candidateId: ids[i] ?? `cand-${i + 1}`,
        candidate,
        rootLabel,
        status: st,
        existingItemId: existing[i] ?? null,
        duplicateOf: duplicateOf[i] ?? null,
        secrets,
        // `changed` zostaje odznaczone: nadpisanie wersji w bibliotece wymaga swiadomego wyboru.
        // Z cudzego repozytorium nic nie jest zaznaczone z gory: uzytkownik wybiera swiadomie (ADR 0058).
        selectedByDefault: !fromGit && secrets.length === 0 && st === 'new',
        dropped,
      };
    });
  }

  /**
   * Powod pominiecia kandydata albo `null`, gdy przechodzi wszystkie bramki. Czysta funkcja:
   * ta sama decyzja jest uzywana przy zbieraniu nazw zajetych w imporcie i przy zapisie.
   */
  private gate(
    scanned: ScannedCandidate | undefined,
    candidateId: string,
    opts: {
      readonly confirmed: ReadonlySet<string>;
      readonly replace: ReadonlySet<string>;
      readonly renames: ReadonlyMap<string, string>;
    },
  ): ApplySkipReason | null {
    if (scanned === undefined) return 'unknown-candidate';
    if (scanned.status === 'duplicate' || scanned.status === 'unchanged') return scanned.status;
    const renamed = opts.renames.has(candidateId);
    if (renamed && scanned.status !== 'conflict') return 'rename-not-allowed';
    if (scanned.status === 'conflict' && !renamed) return 'conflict';
    if (scanned.secrets.length > 0 && !opts.confirmed.has(candidateId)) {
      return 'secrets-not-confirmed';
    }
    if (scanned.status === 'changed' && !opts.replace.has(candidateId)) {
      return 'changed-not-replaced';
    }
    return null;
  }

  async apply(request: ApplyRequest): Promise<ApplyReport> {
    this.purge(this.deps.clock.now().getTime());
    const session = this.sessions.get(request.scanToken);
    if (session === undefined) {
      throw new ImportError(
        'unknown-scan',
        'Skan wygasł albo nie istnieje. Zeskanuj lokalizacje jeszcze raz.',
      );
    }
    const gateOpts = {
      confirmed: new Set(request.confirmedSecrets ?? []),
      replace: new Set(request.replaceChanged ?? []),
      renames: new Map(Object.entries(request.renames ?? {})),
    };
    const ids = [...new Set(request.candidateIds)];
    const imported: { candidateId: string; itemId: string; action: 'created' | 'updated' }[] = [];
    const skipped: { candidateId: string; reason: ApplySkipReason }[] = [];
    const failed: { candidateId: string; code: string; message: string }[] = [];
    const takenSlugs = new Set<string>();

    // Nowa nazwa nie moze zajac miejsca po elemencie z biblioteki ani po kandydacie, ktory idzie
    // do zapisu pod swoja nazwa, niezaleznie od kolejnosci w zadaniu. Biblioteke czytamy tutaj,
    // pod blokada zapisu kanalu `import:apply`; ostateczne rozstrzygniecie i tak robi
    // `LibraryService` w swojej kolejce, wiec wyscig z innym zapisem konczy sie bledem, nie nadpisaniem.
    let libraryKeys = new Set<string>();
    const claimed = new Set<string>();
    if (gateOpts.renames.size > 0) {
      libraryKeys = new Set(
        (await this.deps.library.list()).items.map((item) =>
          slugKey(item.kind, item.identity.slug),
        ),
      );
      for (const candidateId of ids) {
        const scanned = session.candidates.get(candidateId);
        if (scanned === undefined || gateOpts.renames.has(candidateId)) continue;
        if (this.gate(scanned, candidateId, gateOpts) !== null) continue;
        claimed.add(slugKey(scanned.candidate.kind, scanned.candidate.draft.identity.slug));
      }
    }

    for (const candidateId of ids) {
      const scanned = session.candidates.get(candidateId);
      const reason = this.gate(scanned, candidateId, gateOpts);
      if (reason !== null || scanned === undefined) {
        skipped.push({ candidateId, reason: reason ?? 'unknown-candidate' });
        continue;
      }

      const { kind, draft } = scanned.candidate;
      const newSlug = gateOpts.renames.get(candidateId);
      const finalSlug = newSlug ?? draft.identity.slug;
      if (newSlug !== undefined) {
        const problem = renameProblem(kind, newSlug, libraryKeys, claimed, takenSlugs);
        if (problem !== null) {
          failed.push({ candidateId, code: problem.code, message: problem.message });
          continue;
        }
      }
      const slugKeyOfFinal = slugKey(kind, finalSlug);
      if (takenSlugs.has(slugKeyOfFinal)) {
        skipped.push({ candidateId, reason: 'slug-taken-in-this-import' });
        continue;
      }

      try {
        const toSave = this.toDraft(scanned, session, newSlug);
        const noteParts = [
          ...(newSlug !== undefined && newSlug !== draft.identity.slug
            ? [`slug-z=${draft.identity.slug}`]
            : []),
          ...(session.git === null ? [] : [`git=${session.git.url}@${session.git.commit}`]),
          ...(scanned.dropped.length === 0 ? [] : [`usunieto=${scanned.dropped.join(',')}`]),
        ];
        const options = noteParts.length === 0 ? undefined : { note: noteParts.join(' ') };
        const result =
          scanned.status === 'changed' && scanned.existingItemId !== null
            ? await this.deps.library.update(scanned.existingItemId, toSave, options)
            : await this.deps.library.create(toSave, options);
        takenSlugs.add(slugKeyOfFinal);
        session.candidates.delete(candidateId);
        imported.push({
          candidateId,
          itemId: result.item.id,
          action: scanned.status === 'changed' ? 'updated' : 'created',
        });
      } catch (error: unknown) {
        if (error instanceof LibraryError) {
          failed.push({ candidateId, code: error.reason, message: error.message });
        } else {
          this.deps.onUnexpected?.(error);
          failed.push({ candidateId, code: 'internal', message: GENERIC_FAILURE });
        }
      }
    }
    return { imported, skipped, failed };
  }

  /** Szkic z adaptera plus pochodzenie (rootId i sciezka wzgledna) i trafienia klasyfikatora. */
  private toDraft(
    scanned: ScannedCandidate,
    session: ScanSession,
    newSlug: string | undefined,
  ): ItemDraft {
    const { candidate } = scanned;
    const { draft } = candidate;
    const findings: SecretFinding[] = scanned.secrets.map((s) => ({
      rule: s.rule,
      relPath: s.relPath,
      line: s.line,
    }));
    const origin = {
      tool: candidate.tool,
      rootId: candidate.rootId,
      path: candidate.relPath,
      at: this.deps.clock.now().toISOString(),
      ...(session.git === null ? {} : { git: session.git }),
    };
    // Duplikat z innego narzedzia o tej samej tresci dolacza swoj snapshot (ADR 0023), zeby element
    // pamietal oba oryginaly. Duplikat z sekretem nie dolacza, bo nikt go nie potwierdzil.
    const snapshots = [...(draft.source?.snapshots ?? [])];
    for (const other of session.candidates.values()) {
      if (other.status !== 'duplicate' || other.duplicateOf !== scanned.candidateId) continue;
      if (other.secrets.length > 0 || other.candidate.tool === candidate.tool) continue;
      for (const snapshot of other.candidate.draft.source?.snapshots ?? []) {
        if (!snapshots.some((existing) => existing.tool === snapshot.tool))
          snapshots.push(snapshot);
      }
    }
    // Przemianowanie: nazwa ze zrodla zostaje w aliasach. `declaredName` pusty albo rowny starej
    // nazwie (bez wzgledu na wielkosc liter) idzie za nowym slugiem, inaczej eksport do narzedzi
    // kluczujacych po nazwie (Codex, Gemini CLI) zobaczylby dwa elementy o tej samej nazwie
    // (ADR 0057). Inny `declaredName` zostaje (ADR 0026), a kreator ostrzega.
    const renamed = newSlug !== undefined && newSlug !== draft.identity.slug;
    const identity =
      newSlug === undefined || !renamed
        ? draft.identity
        : {
            ...draft.identity,
            slug: newSlug,
            declaredName: followsSlug(draft.identity) ? newSlug : draft.identity.declaredName,
            aliases: draft.identity.aliases.includes(draft.identity.slug)
              ? draft.identity.aliases
              : [...draft.identity.aliases, draft.identity.slug],
          };
    return {
      ...draft,
      identity,
      classification: {
        scope: draft.classification?.scope ?? 'private',
        secretFindings: findings,
      },
      source: {
        snapshots,
        importedFrom: origin,
      },
    };
  }
}
