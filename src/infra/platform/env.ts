import { homedir } from 'node:os';

/**
 * Srodowisko, z ktorego warstwa lokalizacji wylicza sciezki (ADR 0022). Wstrzykiwane, zeby testy
 * podstawialy katalog domowy i system zamiast uruchamiac sie na trzech platformach.
 */
export interface PlatformEnv {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  /** Tylko zmienne nadpisujace lokalizacje narzedzi (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). */
  readonly env: Readonly<Record<string, string | undefined>>;
}

export function systemEnv(): PlatformEnv {
  return { platform: process.platform, homeDir: homedir(), env: process.env };
}
