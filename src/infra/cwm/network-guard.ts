/**
 * Straznik sieci (ADR 0048): `cwm start`, `cwm diff` i `cwm sync` ustawiaja flage na samym poczatku,
 * a `fetchGitSource` odmawia, gdy flaga jest ustawiona. Druga warstwa obok lintu i skanu zrodel:
 * gdyby jakas droga omijajaca statyczne kontrole dotarla do pobierania, proces i tak sie zatrzyma.
 */
let denied = false;

export function denyNetwork(): void {
  denied = true;
}

export const networkDenied = (): boolean => denied;
