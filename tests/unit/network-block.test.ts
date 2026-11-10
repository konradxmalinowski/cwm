import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, session: {} }));

import { blockOutboundNetwork } from '../../src/main/bootstrap/security';
import { APP_ENTRY_URL } from '../../src/main/bootstrap/paths';

/**
 * Blokada sieci (ADR 0008, ARCHITECTURE 12.5): obie kolumny na samym handlerze, bez Electrona.
 * Dowod na zywym rendererze jest w tests/e2e/renderer-hardening.spec.ts (fetch i XHR padaja)
 * i tests/e2e/app-launch.spec.ts (powloka laduje sie ze schematu aplikacji).
 */

type Listener = (details: { url: string }, callback: (r: { cancel: boolean }) => void) => void;

function install(): { filter: { urls: string[] }; decide: (url: string) => boolean } {
  let filter: { urls: string[] } = { urls: [] };
  let listener: Listener = () => undefined;
  const session = {
    webRequest: {
      onBeforeRequest(f: { urls: string[] }, l: Listener) {
        filter = f;
        listener = l;
      },
    },
  };
  blockOutboundNetwork(session as never);
  const decide = (url: string): boolean => {
    let cancel: boolean | null = null;
    listener({ url }, (r) => {
      cancel = r.cancel;
    });
    if (cancel === null) throw new Error(`handler nie odpowiedzial dla ${url}`);
    return cancel;
  };
  return { filter, decide };
}

describe('blokada sieci wychodzacej (ADR 0008)', () => {
  it('blokuje zadania do hostow zewnetrznych i lokalnych (kolumna negatywna)', () => {
    const { decide } = install();
    for (const url of [
      'https://example.com/probe',
      'http://example.com/',
      'http://127.0.0.1:8080/',
      'http://localhost/',
      'wss://example.com/socket',
      'ftp://example.com/plik',
      'nie-url',
    ]) {
      expect(decide(url), url).toBe(true);
    }
  });

  it('przepuszcza protokol aplikacji, blob, data i devtools (kolumna pozytywna)', () => {
    const { decide } = install();
    for (const url of [
      APP_ENTRY_URL,
      'app://bundle/assets/fonts/acme.woff2',
      'blob:app://bundle/0a1b2c3d',
      'data:text/plain;base64,YWNtZQ==',
      'devtools://devtools/bundled/inspector.html',
    ]) {
      expect(decide(url), url).toBe(false);
    }
  });

  it('filtr obejmuje wszystkie schematy sieciowe, a file:// zostaje poza nim', () => {
    // Zmierzone na Electronie z package.json: przy filtrze `*://*/*` ladowanie file:// nie
    // wywoluje handlera i strona sie laduje, a https przechodzi przez handler. Zmiana filtra
    // na wezszy wypuscilaby siec, na szerszy zablokowalaby file:// (ARCHITECTURE 12.5).
    expect(install().filter).toEqual({ urls: ['*://*/*'] });
  });
});
