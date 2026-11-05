import type { Database } from 'better-sqlite3';

import type { ItemId, ItemKind } from '../../core/model/item';
import type {
  IndexedSlug,
  LibraryIndex,
  LibraryIndexEntry,
  RejectedEntry,
} from '../../core/ports/library-index';

const MAX_QUERY_TOKENS = 12;
const MAX_TOKEN_LENGTH = 64;

/**
 * `unicode61` zdejmuje znaki diakrytyczne, ale polska litera l z kreska nie jest znakiem
 * zlozonym i zostaje. Skladamy ja do zwyklego `l` po obu stronach (tresc i zapytanie), zeby
 * zapytanie "lodz" znajdowalo tytul pisany z polskimi znakami.
 */
export function foldForSearch(text: string): string {
  return text.replace(/ł/g, 'l').replace(/Ł/g, 'L');
}

/**
 * Zapytanie uzytkownika na skladnie FTS5. Kazde slowo jest ujete w cudzyslowy (operatory i
 * znaki specjalne traca znaczenie) i dostaje `*` (prefiks). Slowa laczy domyslne AND.
 * Zwraca `null`, gdy w zapytaniu nie ma zadnego slowa.
 */
export function toFtsQuery(query: string): string | null {
  const tokens = foldForSearch(query.normalize('NFC'))
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((token) => token.length > 0)
    .slice(0, MAX_QUERY_TOKENS)
    .map((token) => token.slice(0, MAX_TOKEN_LENGTH));
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(' ');
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    String((error as { code?: unknown }).code).startsWith('SQLITE_CONSTRAINT')
  );
}

interface SeqRow {
  readonly seq: number;
}

/** Indeks biblioteki na tym samym polaczeniu co reszta `index.db` (ADR 0007, ADR 0014). */
export class SqliteLibraryIndex implements LibraryIndex {
  private readonly findSeq;
  private readonly insertItem;
  private readonly updateItem;
  private readonly deleteItem;
  private readonly insertFts;
  private readonly deleteFts;

  constructor(private readonly db: Database) {
    this.findSeq = db.prepare('SELECT seq FROM items WHERE id = ?');
    this.insertItem = db.prepare(
      `INSERT INTO items (id, kind, slug, slug_key, title, description, revision, content_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.updateItem = db.prepare(
      `UPDATE items SET kind = ?, slug = ?, slug_key = ?, title = ?, description = ?,
         revision = ?, content_hash = ?, updated_at = ? WHERE seq = ?`,
    );
    this.deleteItem = db.prepare('DELETE FROM items WHERE seq = ?');
    this.insertFts = db.prepare(
      'INSERT INTO items_fts (rowid, title, description, body, slug) VALUES (?, ?, ?, ?, ?)',
    );
    this.deleteFts = db.prepare('DELETE FROM items_fts WHERE rowid = ?');
  }

  upsert(entry: LibraryIndexEntry): void {
    this.db.transaction(() => this.upsertUnlocked(entry))();
  }

  private upsertUnlocked(entry: LibraryIndexEntry): void {
    const existing = this.findSeq.get(entry.id) as SeqRow | undefined;
    let seq: number;
    if (existing === undefined) {
      const result = this.insertItem.run(
        entry.id,
        entry.kind,
        entry.slug,
        entry.slugKey,
        entry.title,
        entry.description,
        entry.revision,
        entry.contentHash,
        entry.updatedAt,
      );
      seq = Number(result.lastInsertRowid);
    } else {
      seq = existing.seq;
      this.updateItem.run(
        entry.kind,
        entry.slug,
        entry.slugKey,
        entry.title,
        entry.description,
        entry.revision,
        entry.contentHash,
        entry.updatedAt,
        seq,
      );
      this.deleteFts.run(seq);
    }
    this.insertFts.run(
      seq,
      foldForSearch(entry.title),
      foldForSearch(entry.description),
      foldForSearch(entry.body),
      foldForSearch(entry.slug),
    );
  }

  remove(id: ItemId): void {
    this.db.transaction(() => {
      const existing = this.findSeq.get(id) as SeqRow | undefined;
      if (existing === undefined) return;
      this.deleteFts.run(existing.seq);
      this.deleteItem.run(existing.seq);
    })();
  }

  search(query: string, kind?: ItemKind): readonly ItemId[] | null {
    const match = toFtsQuery(query);
    if (match === null) return null;
    const sql = `SELECT items.id AS id FROM items_fts JOIN items ON items.seq = items_fts.rowid
       WHERE items_fts MATCH ?${kind === undefined ? '' : ' AND items.kind = ?'}
       ORDER BY bm25(items_fts, 8.0, 3.0, 1.0, 8.0), items.id`;
    const rows = (
      kind === undefined ? this.db.prepare(sql).all(match) : this.db.prepare(sql).all(match, kind)
    ) as { id: string }[];
    return rows.map((row) => row.id as ItemId);
  }

  slugs(): readonly IndexedSlug[] {
    return (this.db.prepare('SELECT id, kind, slug FROM items').all() as IndexedSlug[]).map(
      (row) => ({ id: row.id, kind: row.kind, slug: row.slug }),
    );
  }

  count(): number {
    const row = this.db.prepare('SELECT count(*) AS total FROM items').get() as
      { total: number } | undefined;
    return row?.total ?? 0;
  }

  replaceAll(entries: readonly LibraryIndexEntry[]): {
    readonly rejected: readonly RejectedEntry[];
  } {
    const rejected: RejectedEntry[] = [];
    this.db.transaction(() => {
      this.db.exec('DELETE FROM items_fts; DELETE FROM items;');
      for (const entry of entries) {
        // Zapis niezgodny z ograniczeniem unikalnosci nie wchodzi, ale nie przerywa reszty.
        // Instrukcja, ktora rzucila, nie zostawia po sobie zmian, wiec FTS nie dostaje sieroty.
        try {
          this.upsertUnlocked(entry);
        } catch (error: unknown) {
          if (!isUniqueViolation(error)) throw error;
          rejected.push({
            id: entry.id,
            reason: 'nazwa koliduje z innym elementem tego samego typu (ADR 0017)',
          });
        }
      }
    })();
    return { rejected };
  }
}
