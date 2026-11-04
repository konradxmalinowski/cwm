/**
 * Syntetyczne sekrety skladane z kawalkow w czasie dzialania testu, zeby zrodlo nie zawieralo
 * ciagu, ktory gitleaks w CI uznalby za prawdziwy klucz (ADR 0004, `.gitleaks.toml`).
 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function filler(length: number, seed = 7): string {
  let state = seed;
  let out = '';
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out += ALPHABET.charAt(state % ALPHABET.length);
  }
  return out;
}

export const SECRETS = {
  openai: ['s', 'k', '-', filler(40)].join(''),
  github: ['g', 'h', 'p', '_', filler(36, 11)].join(''),
  pemBegin: ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '),
  pemEnd: ['-----END', 'RSA PRIVATE KEY-----'].join(' '),
} as const;
