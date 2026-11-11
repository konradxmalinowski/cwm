import { expect, test } from '@playwright/test';

import { removeTempTrees } from '../harness/isolation';
import { launchApp } from './launch';

interface DatabaseReport {
  status: string;
  engine?: string;
  engineVersion?: string;
  sqliteVersion?: string;
  fts5Available?: boolean;
  journalMode?: string;
  schemaVersion?: number;
  locationLabel?: string;
  reason?: string;
}

interface Report {
  database: DatabaseReport;
  runtime: { platform: string; arch: string; packaged: boolean };
  appIcon: string;
}

test.afterAll(() => {
  removeTempTrees();
});

test('better-sqlite3 laduje sie w zbudowanej aplikacji i wykonuje zapytanie', async () => {
  const { app, page } = await launchApp();

  try {
    const report = (await page.evaluate(async () => {
      const bridge = (globalThis as Record<string, unknown>)['uasm'] as {
        diagnostics: { report: () => Promise<unknown> };
      };
      return bridge.diagnostics.report();
    })) as Report;

    expect(report.database.reason).toBeUndefined();
    expect(report.database.status).toBe('ok');
    expect(report.database.engine).toBe('better-sqlite3');
    expect(report.database.sqliteVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report.database.schemaVersion).toBe(4);
    expect(report.database.fts5Available).toBe(true);
    expect(report.database.journalMode).toBe('wal');
  } finally {
    await app.close();
  }
});

test('raport diagnostyczny nie oddaje rendererowi absolutnej sciezki katalogu domowego', async () => {
  const { app, page } = await launchApp();

  try {
    const report = (await page.evaluate(async () => {
      const bridge = (globalThis as Record<string, unknown>)['uasm'] as {
        diagnostics: { report: () => Promise<unknown> };
      };
      return bridge.diagnostics.report();
    })) as Report;

    const homeDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('home'));

    expect(report.database.locationLabel).toBeDefined();
    expect(report.database.locationLabel).not.toContain(homeDir);
    expect(report.appIcon).toBe('provided');
    expect(report.runtime.packaged).toBe(false);
  } finally {
    await app.close();
  }
});
