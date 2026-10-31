import type { Sha256 } from '../model/item';

/**
 * Content store adresowany hashem (ADR 0019, 0027). Trzyma pelne tresci wersji,
 * identyczne bajty zapisuje raz. Implementacja siedzi w `infra/store`.
 */
export interface ObjectStore {
  /** Idempotentne. Zwraca SHA-256 bajtow, ktory implementacja liczy sama. */
  put(bytes: Uint8Array): Promise<Sha256>;
  /** `null`, gdy obiektu nie ma. Obiekt o hashu niezgodnym z trescia jest bledem, nie wynikiem. */
  get(hash: Sha256): Promise<Uint8Array | null>;
  has(hash: Sha256): Promise<boolean>;
}
