import { contextBridge, ipcRenderer } from 'electron';

import { type IpcChannel, isIpcChannel } from '../shared/ipc/channels';
import { buildBridgeSurface } from '../shared/ipc/surface';

const BRIDGE_KEY = 'uasm';

function invoke(channel: IpcChannel, payload?: unknown): Promise<unknown> {
  if (!isIpcChannel(channel)) {
    return Promise.reject(new Error(`kanal IPC poza zamknieta lista: ${String(channel)}`));
  }
  return ipcRenderer.invoke(channel, payload);
}

contextBridge.exposeInMainWorld(BRIDGE_KEY, buildBridgeSurface(invoke));
