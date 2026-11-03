import type { ApplyReport, WritePlan } from '../model/plan';

/**
 * Jedyna droga zapisu do plikow, ktorych aplikacja nie posiada (ADR 0012, 0028, 0031).
 * Adapter zwraca plan bez `recoverability`; `probe` sonduje odczytem kazdy wpis, a `apply`
 * odmawia planu niewykonywalnego, przeterminowanego albo niezatwierdzonego.
 */
export interface WriteGate {
  /** Uzupelnia `recoverability` kazdego wpisu i `applicable`. Tylko odczyt. */
  probe(plan: WritePlan): Promise<WritePlan>;
  /**
   * Zapis z kopia stanu poprzedniego, plik tymczasowy i rename, weryfikacja odczytem
   * i rollback z kopii przy niepowodzeniu. `approval` pochodzi z jawnego zatwierdzenia
   * uzytkownika dla tego `planId`; bez niego zapis nie startuje.
   */
  apply(plan: WritePlan, approval: { readonly planId: string }): Promise<ApplyReport>;
}

/** Wykryta zdolnosc tworzenia dowiazan na tym systemie (ADR 0015). */
export interface LinkCapability {
  readonly fileSymlink: boolean;
  readonly directorySymlink: boolean;
  readonly junction: boolean;
}
