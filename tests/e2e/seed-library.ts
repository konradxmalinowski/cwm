import { join } from 'node:path';

import { systemClock } from '../../src/core/ports/clock';
import { createUlidGenerator, cryptoRandomBytes } from '../../src/core/ports/id-generator';
import { LibraryService } from '../../src/core/services/library/library-service';
import { ensureLibraryDirs } from '../../src/infra/library/ensure-dirs';
import { FsLibraryStore } from '../../src/infra/library/library-store';
import { FsObjectStore } from '../../src/infra/store/object-store';

export interface SeededItem {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
}

const SEED = [
  { slug: 'acme-przeglad', title: 'Przegląd zmian', body: 'Sprawdz zmiany w repozytorium acme.\n' },
  { slug: 'acme-lodz', title: 'Łódzki raport', body: 'Raport z unikalnym slowem znacznikfts.\n' },
  { slug: 'acme-notatki', title: 'Notatki ze spotkania', body: 'Ustalenia z zespolu.\n' },
] as const;

/**
 * Zapisuje syntetyczne elementy do `library/` w katalogu danych, bez indeksu: tak wyglada
 * biblioteka, ktorej indeks zostal skasowany albo jeszcze nie powstal. Tylko syntetyczne dane (ADR 0004).
 */
export async function seedLibrary(userDataDir: string): Promise<SeededItem[]> {
  const library = join(userDataDir, 'library');
  const objects = join(userDataDir, 'objects');
  ensureLibraryDirs(library, objects);
  const service = new LibraryService({
    store: new FsLibraryStore(library),
    objects: new FsObjectStore(objects),
    log: { append: () => Promise.resolve() },
    ids: createUlidGenerator(systemClock, cryptoRandomBytes),
    clock: systemClock,
  });
  const seeded: SeededItem[] = [];
  for (const entry of SEED) {
    const result = await service.create({
      kind: 'skill',
      identity: { slug: entry.slug, declaredName: null, aliases: [] },
      content: {
        title: entry.title,
        description: `Opis: ${entry.title}`,
        descriptionOrigin: 'source',
        body: entry.body,
      },
    });
    seeded.push({ id: result.item.id, slug: entry.slug, title: entry.title });
  }
  return seeded;
}
