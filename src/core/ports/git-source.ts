import type { GitOrigin } from '../model/item';
import type { SourceReader } from './source-reader';
import type { DetectedRoot } from './tool-adapter';

/**
 * Port pobierania zrodla z repozytorium Git (ADR 0058). Core nie zna sieci, procesu `git` ani
 * katalogu tymczasowego: dostaje otwarte zrodlo, czyli rooty wykryte w kopii i czytnik tylko do
 * odczytu, ktory zna wylacznie `rootId` i sciezki wzgledne. Sciezka kopii nie wychodzi poza infra.
 */

export interface GitSourceRequest {
  /** Adres https (po walidacji w main), bez danych logowania. */
  readonly url: string;
  /** Galaz, tag albo pelny SHA; `null` to `HEAD` repozytorium. */
  readonly ref: string | null;
}

export interface OpenedGitSource {
  readonly origin: GitOrigin;
  /** Rooty znalezione w kopii, w kolejnosci pierwszenstwa. Puste, gdy repozytorium nie ma znanego ukladu. */
  readonly roots: readonly DetectedRoot[];
  /** Czyta wylacznie te kopie. Dowiazania prowadzace poza nia sa odrzucane (`outside-root`). */
  readonly reader: SourceReader;
  /** Wpisy typu submodul: nie sa pobierane, wiec w kopii ich nie ma. */
  readonly submodules: readonly string[];
  /** Usuwa kopie. Idempotentne; wolane zawsze po skanie, tez po bledzie. */
  release(): Promise<void>;
}

export type GitSourceFailure =
  /** Brak uruchamialnego `git` (funkcja opcjonalna, ADR 0019). */
  | 'git-unavailable'
  /** Adres, ref albo tresc repozytorium nie przeszly kontroli bezpieczenstwa. */
  | 'rejected'
  /** Pobieranie sie nie udalo: siec, uwierzytelnienie, nieistniejacy ref, limit czasu albo rozmiaru. */
  | 'fetch-failed';

export type GitSourceOpen =
  | { readonly ok: true; readonly source: OpenedGitSource }
  | { readonly ok: false; readonly code: GitSourceFailure; readonly message: string };

export interface GitSourceProvider {
  open(request: GitSourceRequest): Promise<GitSourceOpen>;
  /** Przerywa trwajace pobieranie (zamykanie aplikacji). Brak implementacji to brak przerywania. */
  abort?(): void;
}
