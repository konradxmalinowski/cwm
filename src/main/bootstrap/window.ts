import { BrowserWindow } from 'electron';

import { APP_ENTRY_URL, preloadScript, windowIcon } from './paths';

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#161618',
    title: 'Universal AI Skills Manager',
    // macOS bierze ikone z paczki (.icns), a pole `icon` jest tam ignorowane.
    ...(process.platform === 'darwin' ? {} : { icon: windowIcon() }),
    webPreferences: {
      preload: preloadScript(),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      spellcheck: false,
      enableWebSQL: false,
      navigateOnDragDrop: false,
      devTools: !process.env['UASM_DISABLE_DEVTOOLS'],
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  void window.loadURL(APP_ENTRY_URL);
  return window;
}
