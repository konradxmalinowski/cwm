import { app, BrowserWindow, dialog } from 'electron';

import {
  CANCEL_LABEL,
  CHECKBOX_LABEL,
  fixedConfirmPort,
  singleDialog,
  testConfirmAnswer,
  type ConfirmPort,
} from '../services/native-confirm';

/**
 * Port potwierdzen (ADR 0063): modalne okno systemowe przypiete do okna aplikacji, najwyzej jedno naraz.
 * "Anuluj" jest domyslny i jest odpowiedzia na Esc i zamkniecie okna; zgoda wymaga zaznaczonego pola.
 */
export function createConfirmPort(warn: (message: string) => void): ConfirmPort {
  const answer = testConfirmAnswer(process.env, app.isPackaged);
  if (answer !== null) {
    warn(`[cwm] potwierdzenia natywne zastapione odpowiedzia testowa: ${answer}`);
    return fixedConfirmPort(answer);
  }
  return singleDialog(async (request) => {
    const options = {
      type: 'warning' as const,
      title: 'CWM',
      message: request.message,
      detail: request.detail,
      buttons: [CANCEL_LABEL, request.confirmLabel],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      checkboxLabel: CHECKBOX_LABEL,
      checkboxChecked: false,
    };
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result =
      parent === undefined
        ? await dialog.showMessageBox(options)
        : await dialog.showMessageBox(parent, options);
    return { response: result.response, checkboxChecked: result.checkboxChecked };
  });
}
