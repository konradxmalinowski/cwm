import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['tests/harness/global-setup.ts'],
    include: [
      'tests/unit/**/*.test.ts',
      'tests/contract/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'tests/property/**/*.test.ts',
    ],
    reporters: ['default'],
    passWithNoTests: false,
  },
});
