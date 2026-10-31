import type { BridgeSurface } from '../../../../shared/ipc/surface';

declare global {
  interface Window {
    /** Most do procesu glownego, wystawiony przez preload z zamknietej listy kanalow. */
    readonly uasm?: BridgeSurface;
  }
}

export {};
