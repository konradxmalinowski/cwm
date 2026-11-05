import type { ItemId } from '../../src/core/model/item';
import type {
  IndexedSlug,
  LibraryIndex,
  LibraryIndexEntry,
} from '../../src/core/ports/library-index';

/** Atrapa indeksu: trzyma wpisy w mapie, a kolejnosc wywolan zapisuje do wspolnej listy. */
export class FakeIndex implements LibraryIndex {
  readonly entries = new Map<string, LibraryIndexEntry>();
  readonly calls: string[] = [];
  failUpsert = false;
  failSlugs = false;
  failSearch = false;
  searchResult: readonly ItemId[] | null = [];

  constructor(private readonly timeline: string[] = []) {}

  upsert(entry: LibraryIndexEntry): void {
    this.timeline.push('index:upsert');
    this.calls.push('upsert');
    if (this.failUpsert) throw new Error('indeks niedostepny');
    this.entries.set(entry.id, entry);
  }
  remove(id: ItemId): void {
    this.timeline.push('index:remove');
    this.calls.push('remove');
    this.entries.delete(id);
  }
  search(): readonly ItemId[] | null {
    this.calls.push('search');
    if (this.failSearch) throw new Error('fts');
    return this.searchResult;
  }
  slugs(): readonly IndexedSlug[] {
    this.calls.push('slugs');
    if (this.failSlugs) throw new Error('indeks niedostepny');
    return [...this.entries.values()].map((e) => ({ id: e.id, kind: e.kind, slug: e.slug }));
  }
  count(): number {
    return this.entries.size;
  }
  replaceAll(entries: readonly LibraryIndexEntry[]) {
    this.calls.push('replaceAll');
    this.entries.clear();
    for (const entry of entries) this.entries.set(entry.id, entry);
    return { rejected: [] };
  }
}
