import { defineConfig } from 'vitest/config';

/**
 * Test dymny paczki dystrybucyjnej (ROADMAP Etap 9 kryterium 6). Osobna konfiguracja, bo test
 * potrzebuje zainstalowanego artefaktu z `electron-builder` i nie ma go w zwyklym `npm test`.
 * Uruchamia go CI po instalacji: `UASM_DIST_EXECUTABLE=<binarka> npx vitest run -c vitest.dist.config.ts`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['tests/harness/global-setup.ts'],
    include: ['tests/smoke/**/*.test.ts'],
    reporters: ['default'],
    passWithNoTests: false,
    testTimeout: 180_000,
  },
});
