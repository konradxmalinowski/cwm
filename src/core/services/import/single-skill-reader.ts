import type { RootId } from '../../model/item';
import {
  SourceReadError,
  type SourceEntry,
  type SourceReader,
  type SymlinkTarget,
} from '../../ports/source-reader';

/**
 * Repozytorium z jednym `SKILL.md` w korzeniu nie ma katalogu skilli, a adapter skanuje katalog,
 * w ktorym kazdy skill to podkatalog. Ten czytnik pokazuje korzen kopii jako katalog skilli z
 * jednym podkatalogiem o zadanej nazwie, ktorego zawartoscia jest cala kopia. Nic nie kopiuje i nic
 * nie zapisuje: kazde zapytanie idzie dalej do czytnika wewnetrznego, ze sciezka bez przedrostka.
 */
export class SingleSkillReader implements SourceReader {
  /** `wrapped`: `rootId` na nazwe wirtualnego podkatalogu. Pozostale rooty przechodza bez zmian. */
  constructor(
    private readonly inner: SourceReader,
    private readonly wrapped: ReadonlyMap<RootId, string>,
  ) {}

  async list(root: RootId, relPath: string): Promise<readonly SourceEntry[]> {
    const name = this.wrapped.get(root);
    if (name === undefined) return this.inner.list(root, relPath);
    if (relPath === '') return [{ name, type: 'directory', size: null }];
    return this.inner.list(root, strip(name, relPath));
  }

  read(root: RootId, relPath: string, maxBytes: number): Promise<Uint8Array> {
    const name = this.wrapped.get(root);
    if (name === undefined) return this.inner.read(root, relPath, maxBytes);
    return this.inner.read(root, strip(name, relPath), maxBytes);
  }

  async resolveSymlink(root: RootId, relPath: string): Promise<SymlinkTarget> {
    const name = this.wrapped.get(root);
    if (name === undefined) return this.inner.resolveSymlink(root, relPath);
    const target = await this.inner.resolveSymlink(root, strip(name, relPath));
    return target.relPath === null
      ? target
      : { ...target, relPath: target.relPath === '' ? name : `${name}/${target.relPath}` };
  }

  mode(root: RootId, relPath: string): Promise<number | null> {
    const name = this.wrapped.get(root);
    if (name === undefined) return this.inner.mode(root, relPath);
    return this.inner.mode(root, strip(name, relPath));
  }
}

/** Sciezka w obrebie wirtualnego podkatalogu; inna niz `name` albo `name/...` to `not-found`. */
function strip(name: string, relPath: string): string {
  if (relPath === name) return '';
  if (relPath.startsWith(`${name}/`)) return relPath.slice(name.length + 1);
  throw new SourceReadError('not-found', relPath, `Nie ma "${relPath}" w tym katalogu.`);
}
