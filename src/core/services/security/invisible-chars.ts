/**
 * Znaki, ktore sprawiaja, ze tekst wyglada w podgladzie inaczej, niz sie wykona albo zapisze: formatujace
 * (`Cf`: kierunek tekstu, zerowa szerokosc, miekki dywiz, znaczniki), sterujace (`Cc`), separatory linii i
 * akapitu, selektory wariantu i wypelniacze Hangul. Wspolne dla regul MCP w core i okna potwierdzenia w main.
 */
const FORMAT_OR_CONTROL = /[\p{Cf}\p{Cc}\p{Zl}\p{Zp}]/u;
const HANGUL_FILLERS = new Set([0x115f, 0x1160, 0x3164, 0xffa0]);

export function isInvisibleCodePoint(code: number): boolean {
  return (
    HANGUL_FILLERS.has(code) ||
    code === 0x034f ||
    (code >= 0x180b && code <= 0x180f) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xe0100 && code <= 0xe01ef) ||
    FORMAT_OR_CONTROL.test(String.fromCodePoint(code))
  );
}

export function hasInvisibleChar(text: string): boolean {
  for (const ch of text) {
    if (isInvisibleCodePoint(ch.codePointAt(0) ?? 0)) return true;
  }
  return false;
}
