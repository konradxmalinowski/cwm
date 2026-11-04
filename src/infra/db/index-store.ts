import { accessSync, constants, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type DatabaseConstructor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';

import type { DatabaseProbe } from '../../core/model/diagnostics';
import type { IndexFailureReason } from '../../core/model/index-health';
import type { IndexStore } from '../../core/ports/index-store';
import type { ItemId, Sha256, ToolId } from '../../core/model/item';
import type {
  OperationGroup,
  OperationLog,
  OperationLogReader,
  OperationRecord,
  OperationRow,
  OperationType,
} from '../../core/ports/operation-log';
import type { SyncRecord, SyncStateStore, SyncedFile } from '../../core/ports/sync-state';
import { redactHomePath } from '../logging/redact';

export const SCHEMA_VERSION = 3;

function schemaDir(): string {
  return join(__dirname, 'schema');
}

interface Migration {
  readonly version: number;
  readonly file: string;
}

/** Lista migracji w kolejnosci; `schemaFile` z opcji podmienia tylko pierwsza (szew testowy). */
function migrationList(firstFile: string | undefined): readonly Migration[] {
  return [
    { version: 1, file: firstFile ?? join(schemaDir(), '001-init.sql') },
    { version: 2, file: join(schemaDir(), '002-operation-log.sql') },
    { version: 3, file: join(schemaDir(), '003-sync-state.sql') },
  ];
}

export interface IndexStoreOptions {
  readonly home?: string;
  readonly schemaFile?: string;
}

export class IndexStoreOpenError extends Error {
  constructor(
    readonly reason: IndexFailureReason,
    message: string,
    override readonly cause: unknown,
  ) {
    super(message);
    this.name = 'IndexStoreOpenError';
  }
}

interface VersionRow {
  readonly version: number | null;
}

interface TextRow {
  readonly value: string;
}

interface CountRow {
  readonly total: number;
}

interface RawLogRow {
  readonly seq: number;
  readonly operation: string;
  readonly item_id: string;
  readonly item_kind: string | null;
  readonly slug: string | null;
  readonly at: string;
  readonly before_revision: number | null;
  readonly before_content_hash: string | null;
  readonly before_version_hash: string | null;
  readonly after_revision: number | null;
  readonly after_content_hash: string | null;
  readonly after_version_hash: string | null;
  readonly tool: string | null;
  readonly backup_id: string | null;
  readonly reverts: string | null;
}

function toOperationRow(row: RawLogRow): OperationRow {
  const state = (
    revision: number | null,
    contentHash: string | null,
    versionHash: string | null,
  ) =>
    revision === null || contentHash === null || versionHash === null
      ? null
      : {
          revision,
          contentHash: contentHash as Sha256,
          versionHash: versionHash as Sha256,
        };
  return {
    seq: row.seq,
    operation: row.operation as OperationType,
    itemId: row.item_id as ItemId,
    itemKind: row.item_kind as OperationRow['itemKind'],
    slug: row.slug,
    at: row.at,
    before: state(row.before_revision, row.before_content_hash, row.before_version_hash),
    after: state(row.after_revision, row.after_content_hash, row.after_version_hash),
    ...(row.tool === null ? {} : { tool: row.tool as ToolId }),
    ...(row.backup_id === null ? {} : { backupId: row.backup_id }),
    ...(row.reverts === null ? {} : { reverts: row.reverts }),
  };
}

interface RawSyncRow {
  readonly item_id: string;
  readonly tool: string;
  readonly item_revision: number;
  readonly item_content_hash: string;
  readonly files_json: string;
  readonly synced_at: string;
  readonly backup_id: string;
}

/** Rekord z uszkodzonym JSON-em jest pomijany: stan synchronizacji jest odtwarzalny (ADR 0014). */
function toSyncRecord(row: RawSyncRow): SyncRecord | null {
  let files: SyncedFile[];
  try {
    const parsed: unknown = JSON.parse(row.files_json);
    if (!Array.isArray(parsed)) return null;
    files = parsed as SyncedFile[];
  } catch {
    return null;
  }
  return {
    itemId: row.item_id as ItemId,
    tool: row.tool as ToolId,
    itemRevision: row.item_revision,
    itemContentHash: row.item_content_hash as Sha256,
    files,
    syncedAt: row.synced_at,
    backupId: row.backup_id,
  };
}

/**
 * Sterownik jest wczytywany leniwie, nie importem na gorze modulu.
 *
 * Powod jest konkretny: ADR 0029 wymaga, zeby okno powstawalo niezaleznie od
 * indeksu, a import statyczny modulu natywnego, ktory sie nie laduje, wywala
 * proces zanim jakikolwiek kod zdazy cokolwiek pokazac. Leniwe wczytanie
 * zamienia awarie procesu w rozpoznana przyczyne.
 */
function loadDriver(): typeof DatabaseConstructor {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('better-sqlite3') as typeof DatabaseConstructor;
  } catch (error: unknown) {
    throw new IndexStoreOpenError(
      'native-module',
      'sterownik better-sqlite3 nie daje sie wczytac',
      error,
    );
  }
}

function sqliteErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return '';
}

function classifyOpenError(error: unknown): IndexFailureReason {
  const code = sqliteErrorCode(error);
  if (code === 'SQLITE_NOTADB' || code.startsWith('SQLITE_CORRUPT')) return 'corrupted';
  if (code === 'SQLITE_CANTOPEN' || code === 'EACCES' || code === 'EPERM' || code === 'ENOSPC') {
    return 'not-writable';
  }
  return 'corrupted';
}

function readPackagedVersion(): string {
  try {
    const pkg = readFileSync(
      join(__dirname, '..', '..', '..', 'node_modules', 'better-sqlite3', 'package.json'),
      'utf8',
    );
    const parsed: unknown = JSON.parse(pkg);
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const value = (parsed as { version?: unknown }).version;
      if (typeof value === 'string') return value;
    }
  } catch {
    // Wersja biblioteki to informacja diagnostyczna, nie warunek dzialania.
  }
  return 'unknown';
}

/**
 * Indeks metadanych na `better-sqlite3` (ADR 0007).
 *
 * Schemat jest zakladany przy otwarciu, nie przy pierwszym zapytaniu, bo
 * aplikacja nie ma dzialac z baza w nieznanym stanie schematu, a metoda
 * nazwana `probe` nie ma prawa mutowac schematu.
 *
 * Otwarcie nie podejmuje decyzji, co zrobic z awaria - rozpoznaje przyczyne
 * i oddaje ja w typowanym bledzie. Polityka reakcji jest w bootstrapie
 * procesu glownego (ADR 0029).
 */
export class SqliteIndexStore implements IndexStore {
  private constructor(
    private readonly db: Database,
    private readonly locationLabel: string,
  ) {}

  static open(dbPath: string, options: IndexStoreOptions = {}): SqliteIndexStore {
    const label = redactHomePath(dbPath, options.home ?? homedir());
    const driver = loadDriver();

    try {
      mkdirSync(dirname(dbPath), { recursive: true });
      accessSync(dirname(dbPath), constants.W_OK);
    } catch (error: unknown) {
      throw new IndexStoreOpenError(
        'not-writable',
        `katalog indeksu ${label} nie jest zapisywalny`,
        error,
      );
    }

    let db: Database;
    try {
      db = new driver(dbPath);
    } catch (error: unknown) {
      throw new IndexStoreOpenError(
        classifyOpenError(error),
        `nie udalo sie otworzyc indeksu ${label}`,
        error,
      );
    }

    try {
      db.pragma('journal_mode = WAL');
      SqliteIndexStore.assertSchemaIsUsable(db);
      SqliteIndexStore.migrate(db, migrationList(options.schemaFile));
    } catch (error: unknown) {
      db.close();
      if (error instanceof IndexStoreOpenError) throw error;
      throw new IndexStoreOpenError(
        classifyOpenError(error),
        `migracja indeksu ${label} nie przeszla`,
        error,
      );
    }

    return new SqliteIndexStore(db, label);
  }

  /**
   * Dwa przypadki, ktorych migracja nie powinna nawet probowac tknac.
   *
   * Schemat z przyszlosci: indeks zapisany przez nowsza wersje aplikacji
   * zawiera stan, ktorego ta wersja nie rozumie, w tym log operacji, ktorego
   * z plikow odtworzyc sie nie da (ADR 0014). Odbudowa wyrzucilaby go po
   * cichu, czyli usunelaby dane pod pozorem naprawy.
   *
   * Nieznany schemat: w bazie sa tabele, ale nie ma rejestru migracji, wiec
   * nie wiemy, co to jest ani czym to nadpisujemy.
   */
  private static assertSchemaIsUsable(db: Database): void {
    const tables = db
      .prepare("SELECT count(*) AS total FROM sqlite_master WHERE type = 'table'")
      .get() as CountRow | undefined;
    const ledger = db
      .prepare(
        "SELECT count(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get() as CountRow | undefined;

    const hasTables = (tables?.total ?? 0) > 0;
    const hasLedger = (ledger?.total ?? 0) > 0;

    if (hasTables && !hasLedger) {
      throw new IndexStoreOpenError(
        'unknown-schema',
        'baza ma tabele, ale nie ma rejestru migracji - nie wiadomo, co to za schemat',
        null,
      );
    }

    if (!hasLedger) return;

    const applied = db.prepare('SELECT max(version) AS version FROM schema_migrations').get() as
      VersionRow | undefined;
    const version = applied?.version ?? 0;

    if (version > SCHEMA_VERSION) {
      throw new IndexStoreOpenError(
        'schema-from-future',
        `indeks jest w wersji schematu ${version}, a ta wersja aplikacji zna ${SCHEMA_VERSION}`,
        null,
      );
    }
  }

  /**
   * Idempotentna z konstrukcji: migracja wchodzi do rejestru tylko wtedy, gdy jej tam nie ma,
   * a cala operacja idzie w jednej transakcji. Migracja 1 jest wykonywana zawsze, bo zaklada
   * sam rejestr, z ktorego czytamy biezaca wersje.
   */
  private static migrate(db: Database, migrations: readonly Migration[]): void {
    const sqlByVersion = migrations.map((m) => ({ m, sql: readFileSync(m.file, 'utf8') }));
    const currentVersion = (): number => {
      const applied = db.prepare('SELECT max(version) AS version FROM schema_migrations').get() as
        VersionRow | undefined;
      return applied?.version ?? 0;
    };

    db.transaction(() => {
      for (const { m, sql } of sqlByVersion) {
        if (m.version === 1 || currentVersion() < m.version) db.exec(sql);
        if (currentVersion() < m.version) {
          db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
            m.version,
            new Date().toISOString(),
          );
        }
      }
    })();
  }

  /**
   * Log operacji na tym samym polaczeniu co indeks. Zapis jest synchroniczny i jednowierszowy,
   * wiec nie wymaga transakcji; blad (np. zamkniete polaczenie) leci do `LibraryService`,
   * ktory zamienia go na ostrzezenie.
   */
  operationLog(): OperationLog {
    const insert = this.db.prepare(
      `INSERT INTO operation_log (
         operation, item_id, item_kind, slug, at,
         before_revision, before_content_hash, before_version_hash,
         after_revision, after_content_hash, after_version_hash,
         tool, backup_id, reverts
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    return {
      append: (record: OperationRecord): Promise<void> => {
        try {
          insert.run(
            record.operation,
            record.itemId,
            record.itemKind,
            record.slug,
            record.at,
            record.before?.revision ?? null,
            record.before?.contentHash ?? null,
            record.before?.versionHash ?? null,
            record.after?.revision ?? null,
            record.after?.contentHash ?? null,
            record.after?.versionHash ?? null,
            record.tool ?? null,
            record.backupId ?? null,
            record.reverts ?? null,
          );
          return Promise.resolve();
        } catch (error: unknown) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    };
  }

  /** Odczyt logu pogrupowany po operacjach zapisu do narzedzi (Etap 5, historia). */
  operationLogReader(): OperationLogReader {
    const KEY = "COALESCE('backup:' || backup_id, 'seq:' || seq)";
    const rowsOf = (key: string): OperationRow[] =>
      (
        this.db
          .prepare(`SELECT * FROM operation_log WHERE ${KEY} = ? ORDER BY seq DESC`)
          .all(key) as RawLogRow[]
      ).map(toOperationRow);
    return {
      groups: (limit, before) => {
        try {
          const ceiling =
            before === undefined
              ? Number.MAX_SAFE_INTEGER
              : ((
                  this.db
                    .prepare(`SELECT MAX(seq) AS top FROM operation_log WHERE ${KEY} = ?`)
                    .get(before) as { top: number | null } | undefined
                )?.top ?? 0);
          const heads = this.db
            .prepare(
              `SELECT ${KEY} AS key, MAX(seq) AS top FROM operation_log
               GROUP BY key HAVING top < ? ORDER BY top DESC LIMIT ?`,
            )
            .all(ceiling, limit) as { key: string; top: number }[];
          const groups: OperationGroup[] = heads.map((h) => ({ key: h.key, rows: rowsOf(h.key) }));
          return Promise.resolve(groups);
        } catch (error: unknown) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
      group: (key) => {
        try {
          const rows = rowsOf(key);
          return Promise.resolve(rows.length === 0 ? null : { key, rows });
        } catch (error: unknown) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
      revertedBy: (backupId) => {
        try {
          const row = this.db
            .prepare(
              `SELECT ${KEY} AS key FROM operation_log WHERE reverts = ? ORDER BY seq DESC LIMIT 1`,
            )
            .get(backupId) as { key: string } | undefined;
          return Promise.resolve(row?.key ?? null);
        } catch (error: unknown) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    };
  }

  /** Stan synchronizacji w tym samym indeksie (migracja 3). */
  syncState(): SyncStateStore {
    const wrap = <T>(work: () => T): Promise<T> => {
      try {
        return Promise.resolve(work());
      } catch (error: unknown) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    return {
      get: (itemId, tool) =>
        wrap(() => {
          const row = this.db
            .prepare('SELECT * FROM sync_state WHERE item_id = ? AND tool = ?')
            .get(itemId, tool) as RawSyncRow | undefined;
          return row === undefined ? null : toSyncRecord(row);
        }),
      list: (tool) =>
        wrap(() => {
          const rows = (
            tool === undefined
              ? this.db.prepare('SELECT * FROM sync_state ORDER BY item_id, tool').all()
              : this.db
                  .prepare('SELECT * FROM sync_state WHERE tool = ? ORDER BY item_id')
                  .all(tool)
          ) as RawSyncRow[];
          return rows.flatMap((row) => {
            const record = toSyncRecord(row);
            return record === null ? [] : [record];
          });
        }),
      put: (record) =>
        wrap(() => {
          this.db
            .prepare(
              `INSERT OR REPLACE INTO sync_state (
                 item_id, tool, item_revision, item_content_hash, files_json, synced_at, backup_id
               ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              record.itemId,
              record.tool,
              record.itemRevision,
              record.itemContentHash,
              JSON.stringify(record.files),
              record.syncedAt,
              record.backupId,
            );
        }),
      remove: (itemId, tool) =>
        wrap(() => {
          this.db
            .prepare('DELETE FROM sync_state WHERE item_id = ? AND tool = ?')
            .run(itemId, tool);
        }),
    };
  }

  /** Odczyt stanu, bez zapisu. */
  probe(): DatabaseProbe {
    try {
      const sqliteVersion = this.db.prepare('SELECT sqlite_version() AS value').get() as
        TextRow | undefined;
      const journalMode = this.db.prepare('PRAGMA journal_mode').get() as
        { readonly journal_mode?: string } | undefined;
      const schemaVersion = this.db
        .prepare('SELECT max(version) AS version FROM schema_migrations')
        .get() as VersionRow | undefined;
      const fts5 = this.db
        .prepare(
          "SELECT count(*) AS total FROM pragma_compile_options WHERE compile_options = 'ENABLE_FTS5'",
        )
        .get() as CountRow | undefined;

      return {
        status: 'ok',
        engine: 'better-sqlite3',
        engineVersion: readPackagedVersion(),
        sqliteVersion: sqliteVersion?.value ?? 'unknown',
        fts5Available: (fts5?.total ?? 0) > 0,
        journalMode: journalMode?.journal_mode ?? 'unknown',
        schemaVersion: schemaVersion?.version ?? 0,
        locationLabel: this.locationLabel,
      };
    } catch (error: unknown) {
      return {
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        locationLabel: this.locationLabel,
      };
    }
  }

  close(): void {
    this.db.close();
  }
}
