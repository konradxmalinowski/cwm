import { describe, expect, it } from 'vitest';

import {
  BLOCK_END,
  BLOCK_START,
  applyMarkerBlock,
  containsManagedContent,
  hasManagedBlock,
} from '../../src/adapters/shared/marker-block';

const body = 'Linia pierwsza.\n\nLinia druga.\n';

describe('blok miedzy markerami (ADR 0025)', () => {
  it('markery sa komentarzami Markdown w przestrzeni nazw aplikacji', () => {
    expect(BLOCK_START).toBe('<!-- ai-skills-manager:start -->');
    expect(BLOCK_END).toBe('<!-- ai-skills-manager:end -->');
  });

  it('regula 4: brak pliku daje plik z samym blokiem', () => {
    expect(applyMarkerBlock(null, body)).toEqual({
      kind: 'created',
      text: `${BLOCK_START}\n${body}${BLOCK_END}\n`,
    });
  });

  it('regula 2: plik bez markerow dostaje blok na koncu, poczatek zostaje bajt w bajt', () => {
    const before = '# Moje\r\n\r\nTekst bez konca linii';
    const r = applyMarkerBlock(before, body);
    expect(r.kind).toBe('appended');
    if (r.kind !== 'appended') return;
    expect(r.text.startsWith(before)).toBe(true);
    expect(r.text.endsWith(`${BLOCK_END}\r\n`)).toBe(true);
    expect(r.text).toContain(
      `${BLOCK_START}\r\nLinia pierwsza.\r\n\r\nLinia druga.\r\n${BLOCK_END}`,
    );
  });

  it('regula 1: istniejacy blok jest podmieniany, reszta pliku bez zmian', () => {
    const before = `a\n\n${BLOCK_START}\nstare\n${BLOCK_END}\nkoniec bez nowej linii`;
    const r = applyMarkerBlock(before, body);
    expect(r.kind).toBe('replaced');
    if (r.kind !== 'replaced') return;
    expect(r.text).toBe(`a\n\n${BLOCK_START}\n${body}${BLOCK_END}\nkoniec bez nowej linii`);
    // Ponowne zastosowanie nic nie zmienia.
    expect(applyMarkerBlock(r.text, body).kind).toBe('unchanged');
  });

  it('regula 3: ta sama tresc bez markerow to konflikt, nie zgadywanie', () => {
    const r = applyMarkerBlock(`Wstep\n${body}\nKoniec\n`, body);
    expect(r.kind).toBe('conflict');
    const lines = 'a\nb\nc\n';
    expect(applyMarkerBlock('c\n\nb\n\na\n', lines).kind).toBe('conflict');
  });

  it('plik bez tej tresci nie jest konfliktem i dostaje dopisany blok', () => {
    expect(containsManagedContent('zupelnie inny plik\n', body)).toBe(false);
    expect(applyMarkerBlock('zupelnie inny plik\n', body).kind).toBe('appended');
  });

  it('uszkodzone markery aplikacji sa odmowa, a nie zgadywaniem', () => {
    expect(applyMarkerBlock(`${BLOCK_START}\nx\n`, body).kind).toBe('refused');
    expect(applyMarkerBlock(`${BLOCK_END}\n${BLOCK_START}\n`, body).kind).toBe('refused');
    expect(
      applyMarkerBlock(`${BLOCK_START}\n${BLOCK_END}\n${BLOCK_START}\n${BLOCK_END}\n`, body).kind,
    ).toBe('refused');
  });

  it('nie wpisuje bloku do srodka niezamknietego bloku obcego narzedzia', () => {
    const r = applyMarkerBlock('<!-- antislop:start -->\ntresc\n', body);
    expect(r.kind).toBe('refused');
  });

  it('blok obcego narzedzia zamkniety nie przeszkadza w dopisaniu', () => {
    const before = '<!-- antislop:start -->\ntresc\n<!-- antislop:end -->\n';
    const r = applyMarkerBlock(before, body);
    expect(r.kind).toBe('appended');
    if (r.kind === 'appended') expect(r.text.startsWith(before)).toBe(true);
  });

  it('rozpoznaje blok aplikacji tylko gdy sa oba markery', () => {
    expect(hasManagedBlock(`${BLOCK_START}\n${BLOCK_END}\n`)).toBe(true);
    expect(hasManagedBlock(`${BLOCK_START}\n`)).toBe(false);
    expect(hasManagedBlock('<!-- antislop:start -->\n<!-- antislop:end -->\n')).toBe(false);
  });
});
