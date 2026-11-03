import type { ToolId } from '../../core/model/item';
import { MAX_FILE_BYTES } from '../../core/model/library-limits';
import type {
  DetectedRoot,
  ImportCandidate,
  ImportSkip,
  ScanResult,
} from '../../core/ports/tool-adapter';
import {
  SourceReadError,
  type SourceEntry,
  type SourceEntryType,
  type SourceReader,
} from '../../core/ports/source-reader';

export type SkipReason = ImportSkip['reason'];

export type Followed =
  | { readonly outside: true }
  | {
      readonly outside: false;
      /** Sciezka celu w obrebie roota; to z niej czyta sie bajty. */
      readonly relPath: string;
      readonly identity: string | null;
      readonly type: SourceEntryType | null;
    };

const MIB = 1024 * 1024;

/**
 * Wspolny stan jednego skanu: zbiera wyniki i zamienia bledy odczytu pojedynczego pliku na
 * `ImportSkip` (kryterium 8). Trzyma tylko `SourceReader`, wiec skan nie ma jak niczego zapisac.
 */
export class ScanContext {
  readonly candidates: Omit<ImportCandidate, 'tool' | 'rootId'>[] = [];
  readonly skipped: Omit<ImportSkip, 'tool' | 'rootId'>[] = [];

  constructor(
    readonly tool: ToolId,
    readonly root: DetectedRoot,
    private readonly reader: SourceReader,
  ) {}

  skip(relPath: string, reason: SkipReason, message: string): void {
    this.skipped.push({ relPath, reason, message });
  }

  add(candidate: Omit<ImportCandidate, 'tool' | 'rootId'>): void {
    this.candidates.push(candidate);
  }

  list(relPath: string): Promise<readonly SourceEntry[]> {
    return this.reader.list(this.root.rootId, relPath);
  }

  read(relPath: string): Promise<Uint8Array> {
    return this.reader.read(this.root.rootId, relPath, MAX_FILE_BYTES);
  }

  /** Tryb pliku jest dodatkiem do snapshotu; jego brak nie moze wywrocic importu. */
  async mode(relPath: string): Promise<number | null> {
    try {
      return await this.reader.mode(this.root.rootId, relPath);
    } catch (error) {
      if (error instanceof SourceReadError) return null;
      throw error;
    }
  }

  /**
   * Klucz aliasu to root plus sciezka celu. Czytnik podaje `identity` tylko dla dowiazan, wiec cel
   * i jego alias porownujemy po sciezce wzgledem roota, w tym samym formacie po obu stronach.
   */
  aliasKey(targetRelPath: string): string {
    return `${this.root.rootId}:${targetRelPath}`;
  }

  /** Rozwiazuje dowiazanie w obrebie roota i ustala, czym jest jego cel. Rzuca `SourceReadError`. */
  async follow(relPath: string): Promise<Followed> {
    const target = await this.reader.resolveSymlink(this.root.rootId, relPath);
    if (target.relPath === null) return { outside: true };
    const slash = target.relPath.lastIndexOf('/');
    const parent = slash === -1 ? '' : target.relPath.slice(0, slash);
    const name = target.relPath.slice(slash + 1);
    const entries = await this.reader.list(this.root.rootId, parent);
    const type = entries.find((e) => e.name === name)?.type ?? null;
    return { outside: false, relPath: target.relPath, identity: target.identity, type };
  }

  /**
   * Zamienia blad odczytu na `ImportSkip` z nazwa pliku. Inne wyjatki to bledy programu i leca dalej,
   * zeby test je zlapal zamiast chowac je w raporcie importu.
   */
  skipFromError(error: unknown, relPath: string): void {
    if (!(error instanceof SourceReadError)) throw error;
    switch (error.failure) {
      case 'not-found':
        this.skip(relPath, 'unreadable', `Plik "${relPath}" zniknął w trakcie skanowania.`);
        break;
      case 'permission-denied':
        this.skip(relPath, 'unreadable', `Brak uprawnień do odczytu pliku "${relPath}".`);
        break;
      case 'too-large':
        this.skip(
          relPath,
          'too-large',
          `Plik "${relPath}" jest większy niż limit ${MAX_FILE_BYTES / MIB} MiB.`,
        );
        break;
      case 'not-a-file':
        this.skip(relPath, 'unsupported', `"${relPath}" nie jest zwykłym plikiem.`);
        break;
      case 'outside-root':
        this.skip(
          relPath,
          'symlink-outside',
          `"${relPath}" wskazuje poza wybrany katalog i nie jest śledzone.`,
        );
        break;
      default:
        this.skip(relPath, 'unreadable', `Nie udało się odczytać "${relPath}".`);
    }
  }

  result(): ScanResult {
    const byPath = <T extends { readonly relPath: string }>(a: T, b: T): number =>
      a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0;
    return {
      candidates: this.candidates
        .map((c) => ({ ...c, tool: this.tool, rootId: this.root.rootId }))
        .sort(byPath),
      skipped: this.skipped
        .map((s) => ({ ...s, tool: this.tool, rootId: this.root.rootId }))
        .sort(byPath),
    };
  }
}

export function unsupportedRootKind(tool: ToolId, root: DetectedRoot, label: string): ScanResult {
  return {
    candidates: [],
    skipped: [
      {
        tool,
        rootId: root.rootId,
        relPath: '',
        reason: 'unsupported',
        message: `${label} nie obsługuje katalogów rodzaju "${root.kind}".`,
      },
    ],
  };
}
