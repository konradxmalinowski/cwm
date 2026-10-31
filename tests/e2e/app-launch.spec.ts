import { expect, test } from '@playwright/test';

import { removeTempTrees } from '../harness/isolation';
import { launchApp } from './launch';

test.afterAll(() => {
  removeTempTrees();
});

test('aplikacja startuje, okno sie pojawia i powloka renderera jest widoczna', async () => {
  const { app, page } = await launchApp();

  try {
    await expect(page.locator('[data-testid="app-shell"]')).toBeVisible();
    expect(await page.title()).toBe('Universal AI Skills Manager');

    const windowCount = await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    );
    expect(windowCount).toBe(1);
  } finally {
    await app.close();
  }
});

test('renderer jest serwowany ze schematu aplikacji, nie z file://', async () => {
  const { app, page } = await launchApp();

  try {
    expect(page.url()).toBe('app://bundle/index.html');
  } finally {
    await app.close();
  }
});

test('okno jest skonfigurowane zgodnie z ADR 0008', async () => {
  const { app } = await launchApp();

  try {
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows();
      // `getLastWebPreferences` istnieje w czasie dzialania, ale nie jest
      // w publicznych typach Electrona. Czytamy je przez rzutowanie, bo to
      // jedyny sposob sprawdzic faktyczna konfiguracje okna, a nie te wartosci,
      // ktore chcielismy przekazac.
      const contents = window?.webContents as unknown as
        { getLastWebPreferences?: () => Record<string, unknown> | null } | undefined;
      const prefs = contents?.getLastWebPreferences?.() ?? {};
      return {
        sandbox: prefs['sandbox'] ?? null,
        contextIsolation: prefs['contextIsolation'] ?? null,
        nodeIntegration: prefs['nodeIntegration'] ?? null,
        webSecurity: prefs['webSecurity'] ?? null,
        webviewTag: prefs['webviewTag'] ?? null,
      };
    });

    expect(prefs.sandbox).toBe(true);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.webSecurity).not.toBe(false);
    expect(prefs.webviewTag).not.toBe(true);
  } finally {
    await app.close();
  }
});
