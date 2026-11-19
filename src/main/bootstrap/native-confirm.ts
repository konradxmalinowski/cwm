import { app, BrowserWindow, dialog } from 'electron';

import {
  CANCEL_LABEL,
  fixedConfirmPort,
  testConfirmAnswer,
  type ConfirmPort,
  type ConfirmRequest,
} from '../services/native-confirm';

/**
 * Port potwierdzen (ADR 0063): modalne okno systemowe przypiete do okna aplikacji. Jedno okno naraz,
 * kolejne czeka w kolejce. "Anuluj" jest domyslny i jest odpowiedzia na Esc i zamkniecie okna.
 */
export function createConfirmPort(warn: (message: string) => void): ConfirmPort {
  const answer = testConfirmAnswer(process.env, app.isPackaged);
  if (answer !== null) {
    warn(`[cwm] potwierdzenia natywne zastapione odpowiedzia testowa: ${answer}`);
    return fixedConfirmPort(answer);
  }
  let queue: Promise<unknown> = Promise.resolve();
  const show = async (request: ConfirmRequest): Promise<boolean> => {
    const options = {
      type: 'warning' as const,
      title: 'CWM',
      message: request.message,
      detail: request.detail,
      buttons: [CANCEL_LABEL, request.confirmLabel],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    try {
      const result =
        parent === undefined
          ? await dialog.showMessageBox(options)
          : await dialog.showMessageBox(parent, options);
      return result.response === 1;
    } catch {
      return false;
    }
  };
  return {
    confirm(request) {
      const run = queue.then(
        () => show(request),
        () => show(request),
      );
      queue = run;
      return run;
    },
  };
}
