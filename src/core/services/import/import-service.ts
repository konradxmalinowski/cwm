import type { ItemDraft, LibraryItem, SecretFinding, Sha256, ToolId } from '../../model/item';
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
import type { SourceReader } from '../../ports/source-reader';
import type { LibraryService } from '../library/library-service';
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
}

export interface ScannedSkip extends ImportSkip {
  readonly rootLabel: string;
}

export interface ScanReport {
  readonly scanToken: string;
  readonly candidates: readonly ScannedCandidate[];
  readonly skipped: readonly ScannedSkip[];
}

export interface ApplyRequest {
  readonly scanToken: string;
  readonly candidateIds: readonly string[];
  readonly confirmedSecrets?: readonly string[];
  readonly replaceChanged?: readonly string[];
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
  | 'slug-taken-in-this-import';

export type ImportErrorCode = 'unknown-root' | 'unknown-scan';

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

interface ScanSession {
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

  constructor(private readonly deps: ImportServiceDeps) {
    this.adapters = new Map(deps.adapters.map((a) => [a.id, a]));
    this.ttlMs = deps.ttlMs ?? SCAN_TTL_MS;
    this.newToken = deps.newToken ?? defaultToken;
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

    const raw: { candidate: ImportCandidate; rootLabel: string; secrets: SecretHit[] }[] = [];
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
        scans.push({ root, result: await adapter.scan(root, this.deps.reader) });
      } catch (error: unknown) {
        this.deps.onUnexpected?.(error);
        skip('unreadable', `Nie udało się przeskanować lokalizacji ${root.label}.`);
      }
    }

    for (const done of await this.finalizeScans(scans)) {
      for (const candidate of done.result.candidates) {
        raw.push({ candidate, rootLabel: done.root.label, secrets: this.classify(candidate) });
      }
      for (const s of done.result.skipped) skipped.push({ ...s, rootLabel: done.root.label });
    }

    const library = (await this.deps.library.list()).items;
    const candidates = this.resolveStatuses(raw, library);
    const scanToken = this.remember(candidates);
    return { scanToken, candidates, skipped };
  }

  /** Krok `finalize` adaptera po skanie rootow jednego narzedzia; blad adaptera nie psuje reszty. */
  private async finalizeScans(scans: readonly RootScan[]): Promise<readonly RootScan[]> {
    const out = [...scans];
    for (const tool of new Set(scans.map((s) => s.root.tool))) {
      const adapter = this.adapters.get(tool);
      if (adapter?.finalize === undefined) continue;
      const mine = scans.filter((s) => s.root.tool === tool);
      try {
        const results = await adapter.finalize(mine, this.deps.reader);
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

  private remember(candidates: readonly ScannedCandidate[]): string {
    const now = this.deps.clock.now().getTime();
    this.purge(now);
    while (this.sessions.size >= MAX_SCAN_SESSIONS) {
      const oldest = this.sessions.keys().next();
      if (oldest.done === true) break;
      this.sessions.delete(oldest.value);
    }
    const token = this.newToken();
    this.sessions.set(token, {
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
    raw: readonly { candidate: ImportCandidate; rootLabel: string; secrets: SecretHit[] }[],
    library: readonly LibraryItem[],
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

    return raw.map(({ candidate, rootLabel, secrets }, i) => {
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
        selectedByDefault: secrets.length === 0 && st === 'new',
      };
    });
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
    const confirmed = new Set(request.confirmedSecrets ?? []);
    const replace = new Set(request.replaceChanged ?? []);
    const imported: { candidateId: string; itemId: string; action: 'created' | 'updated' }[] = [];
    const skipped: { candidateId: string; reason: ApplySkipReason }[] = [];
    const failed: { candidateId: string; code: string; message: string }[] = [];
    const takenSlugs = new Set<string>();

    for (const candidateId of new Set(request.candidateIds)) {
      const scanned = session.candidates.get(candidateId);
      const skip = (reason: ApplySkipReason): void => {
        skipped.push({ candidateId, reason });
      };
      if (scanned === undefined) {
        skip('unknown-candidate');
        continue;
      }
      if (scanned.status === 'duplicate' || scanned.status === 'unchanged') {
        skip(scanned.status);
        continue;
      }
      if (scanned.status === 'conflict') {
        skip('conflict');
        continue;
      }
      if (scanned.secrets.length > 0 && !confirmed.has(candidateId)) {
        skip('secrets-not-confirmed');
        continue;
      }
      if (scanned.status === 'changed' && !replace.has(candidateId)) {
        skip('changed-not-replaced');
        continue;
      }

      const { kind, draft } = scanned.candidate;
      const slugKey = `${kind}\0${draft.identity.slug.toLowerCase()}`;
      if (takenSlugs.has(slugKey)) {
        skip('slug-taken-in-this-import');
        continue;
      }

      try {
        const toSave = this.toDraft(scanned, session);
        const result =
          scanned.status === 'changed' && scanned.existingItemId !== null
            ? await this.deps.library.update(scanned.existingItemId, toSave)
            : await this.deps.library.create(toSave);
        takenSlugs.add(slugKey);
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
  private toDraft(scanned: ScannedCandidate, session: ScanSession): ItemDraft {
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
    return {
      ...draft,
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
