import type { Sha256 } from '../../model/item';
import type { RetentionSettings } from '../../model/retention';
import type { RetentionLogRow } from '../../ports/retention';

/**
 * Czysty rdzen retencji (ADR 0056): z wierszy logu, osiagalnosci i rozmiarow obiektow wylicza,
 * ktore wpisy przyciac i ktore obiekty mozna usunac. Nie czyta dysku ani bazy. Obiekt wolno usunac
 * wylacznie wtedy, gdy nic z zachowanych wpisow ani z biblioteki do niego nie prowadzi; wieku
 * obiektu nie bierze pod uwage nigdzie (ADR 0027).
 */

const DAY_MS = 86_400_000;
const MIB = 1024 * 1024;
/** Najnowsze grupy zostaja zawsze, niezaleznie od limitow wieku i rozmiaru (ADR 0056). */
export const MIN_KEPT_GROUPS = 10;
const WRITE_OPERATIONS: ReadonlySet<string> = new Set(['export', 'sync', 'rollback']);

/** Wiersze jednej operacji, tak jak widzi je historia: wspolny `backup_id`, a bez niego pojedynczy wiersz. */
export interface LogGroup {
  readonly key: string;
  readonly seqs: readonly number[];
  readonly newestSeq: number;
  /** Czas najnowszego wiersza grupy; `null`, gdy nie da sie go odczytac (taki wpis nie starzeje sie). */
  readonly atMs: number | null;
  readonly backupId: string | null;
  /** `backupId` operacji, ktore ta grupa cofnela. */
  readonly reverts: readonly string[];
  /** Zapis do narzedzia z kopia, czyli cos, co da sie cofnac z historii. */
  readonly revertibleWrite: boolean;
  /** Rekordy wersji i manifesty stanu z `before` i `after` wierszy grupy. */
  readonly rootHashes: readonly Sha256[];
}

export interface RetentionGroup extends LogGroup {
  /** Domkniecie `rootHashes` o obiekty, na ktore te wskazuja (assety, snapshoty, pliki z dysku). */
  readonly hashes: readonly Sha256[];
  /** Korzen tej grupy nie dal sie odczytac, wiec `hashes` moze byc niepelne. */
  readonly unreadable?: boolean;
}

export function groupLogRows(rows: readonly RetentionLogRow[]): LogGroup[] {
  const byKey = new Map<string, RetentionLogRow[]>();
  for (const row of rows) {
    const key = row.backupId === null ? `seq:${row.seq}` : `backup:${row.backupId}`;
    const bucket = byKey.get(key);
    if (bucket === undefined) byKey.set(key, [row]);
    else bucket.push(row);
  }
  const groups: LogGroup[] = [];
  for (const [key, bucket] of byKey) {
    const newest = bucket.reduce((a, b) => (b.seq > a.seq ? b : a));
    const at = Date.parse(newest.at);
    const backupId = newest.backupId;
    groups.push({
      key,
      seqs: bucket.map((r) => r.seq),
      newestSeq: newest.seq,
      atMs: Number.isNaN(at) ? null : at,
      backupId,
      reverts: [...new Set(bucket.flatMap((r) => (r.reverts === null ? [] : [r.reverts])))],
      revertibleWrite: backupId !== null && bucket.some((r) => WRITE_OPERATIONS.has(r.operation)),
      rootHashes: [...new Set(bucket.flatMap((r) => r.versionHashes))],
    });
  }
  return groups.sort((a, b) => a.newestSeq - b.newestSeq);
}

export interface RetentionPlanInput {
  readonly settings: RetentionSettings;
  readonly nowMs: number;
  readonly groups: readonly RetentionGroup[];
  /** Domkniecie korzeni biblioteki: zawsze chronione. */
  readonly libraryHashes: readonly Sha256[];
  /** Obiekty obecne w store z rozmiarami w bajtach. */
  readonly objectSizes: ReadonlyMap<Sha256, number>;
  /** Ile najnowszych grup jest nietykalnych; produkcja uzywa `MIN_KEPT_GROUPS`. */
  readonly minKeepGroups: number;
}

export interface RetentionPlan {
  readonly pruneKeys: readonly string[];
  readonly pruneSeqs: readonly number[];
  readonly protectedKeys: readonly string[];
  readonly entriesBefore: number;
  /** Obiekty bez zadnego odwolania po przycieciu, w tym osierocone przez wczesniej przerwany przebieg. */
  readonly sweep: readonly Sha256[];
  readonly objectsBefore: number;
  readonly bytesBefore: number;
  readonly bytesToFree: number;
  readonly sizeLimitUnmet: boolean;
  /** Zegar jest przed najnowszym wpisem logu, wiec limit wieku zostal pominiety. */
  readonly ageRuleSkipped: boolean;
}

export function planRetention(input: RetentionPlanInput): RetentionPlan {
  const { settings, objectSizes } = input;
  const groups = [...input.groups].sort((a, b) => a.newestSeq - b.newestSeq);

  // Ostatnia operacja, ktora da sie cofnac (zapis z kopia, jeszcze nie cofniety), jest chroniona
  // razem z tym, czego cofniecie potrzebuje.
  const reverted = new Set(groups.flatMap((g) => g.reverts));
  const protectedKeys = new Set<string>();
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const g = groups[i];
    if (g?.revertibleWrite === true && g.backupId !== null && !reverted.has(g.backupId)) {
      protectedKeys.add(g.key);
      break;
    }
  }

  // Podloga: najnowsze grupy zostaja bez wzgledu na limity.
  for (const g of groups.slice(Math.max(0, groups.length - input.minKeepGroups))) {
    protectedKeys.add(g.key);
  }

  const keyByBackup = new Map<string, string>();
  for (const g of groups) if (g.backupId !== null) keyByBackup.set(g.backupId, g.key);

  const refs = new Map<Sha256, number>();
  let reachable = 0;
  const retain = (hash: Sha256): void => {
    const next = (refs.get(hash) ?? 0) + 1;
    refs.set(hash, next);
    if (next === 1) reachable += objectSizes.get(hash) ?? 0;
  };
  const release = (hash: Sha256): void => {
    const next = (refs.get(hash) ?? 0) - 1;
    if (next > 0) {
      refs.set(hash, next);
      return;
    }
    refs.delete(hash);
    reachable -= objectSizes.get(hash) ?? 0;
  };
  for (const hash of new Set(input.libraryHashes)) retain(hash);
  for (const g of groups) for (const hash of new Set(g.hashes)) retain(hash);

  const pruned = new Set<string>();
  // Wpis cofajacy zostaje, dopoki zostaje wpis cofniety: inaczej cofniety zapis wygladalby znow na
  // mozliwy do cofniecia, a jego kopia mogla by zostac zastosowana drugi raz.
  const canDrop = (g: RetentionGroup): boolean =>
    !protectedKeys.has(g.key) &&
    g.reverts.every((backupId) => {
      const target = keyByBackup.get(backupId);
      return target === undefined || pruned.has(target);
    });
  const drop = (g: RetentionGroup): void => {
    pruned.add(g.key);
    for (const hash of new Set(g.hashes)) release(hash);
  };

  let excess = settings.maxEntries === null ? 0 : Math.max(0, groups.length - settings.maxEntries);
  // Zegar sprzed najnowszego wpisu to zegar nieprawdziwy: wiek niczego wtedy nie dowodzi.
  const newestAt = Math.max(-Infinity, ...groups.map((g) => g.atMs ?? -Infinity));
  const ageRuleSkipped = settings.maxAgeDays !== null && input.nowMs < newestAt;
  const cutoff =
    settings.maxAgeDays === null || ageRuleSkipped
      ? null
      : input.nowMs - settings.maxAgeDays * DAY_MS;
  for (const g of groups) {
    const expired = cutoff !== null && g.atMs !== null && g.atMs < cutoff;
    if (!expired && excess <= 0) continue;
    if (!canDrop(g)) continue;
    drop(g);
    if (excess > 0) excess -= 1;
  }

  const limitBytes = settings.maxStoreMiB === null ? null : settings.maxStoreMiB * MIB;
  if (limitBytes !== null) {
    for (const g of groups) {
      if (reachable <= limitBytes) break;
      if (pruned.has(g.key) || !canDrop(g)) continue;
      drop(g);
    }
  }

  let bytesBefore = 0;
  let bytesToFree = 0;
  const sweep: Sha256[] = [];
  for (const [hash, size] of objectSizes) {
    bytesBefore += size;
    if (refs.has(hash)) continue;
    sweep.push(hash);
    bytesToFree += size;
  }

  return {
    pruneKeys: groups.filter((g) => pruned.has(g.key)).map((g) => g.key),
    pruneSeqs: groups.filter((g) => pruned.has(g.key)).flatMap((g) => g.seqs),
    protectedKeys: [...protectedKeys],
    entriesBefore: groups.length,
    sweep,
    objectsBefore: objectSizes.size,
    bytesBefore,
    bytesToFree,
    sizeLimitUnmet: limitBytes !== null && reachable > limitBytes,
    ageRuleSkipped,
  };
}
