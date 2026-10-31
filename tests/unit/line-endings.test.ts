import { describe, expect, it } from 'vitest';

import {
  detectLineEnding,
  normalizeToLf,
} from '../../src/core/services/normalization/line-endings';

describe('detekcja koncow linii', () => {
  it('rozpoznaje lf, crlf i mixed', () => {
    expect(detectLineEnding('a\nb\n')).toBe('lf');
    expect(detectLineEnding('a\r\nb\r\n')).toBe('crlf');
    expect(detectLineEnding('a\r\nb\nc\r\n')).toBe('mixed');
  });

  it('tekst bez koncow linii i pusty tekst to lf', () => {
    expect(detectLineEnding('')).toBe('lf');
    expect(detectLineEnding('jedna linia')).toBe('lf');
  });

  it('samotne CR to mixed, takze gdy jest jedynym koncem linii', () => {
    expect(detectLineEnding('a\rb\rc')).toBe('mixed');
    expect(detectLineEnding('a\r\nb\rc')).toBe('mixed');
  });

  it('CR na samym koncu tekstu jest samotnym CR', () => {
    expect(detectLineEnding('a\r')).toBe('mixed');
  });
});

describe('normalizacja do LF', () => {
  it('zamienia CRLF i samotne CR na LF', () => {
    expect(normalizeToLf('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it('nie rusza tekstu, ktory juz jest w LF', () => {
    expect(normalizeToLf('a\nb\n')).toBe('a\nb\n');
  });

  it('zachowuje pusty tekst i polskie znaki', () => {
    expect(normalizeToLf('')).toBe('');
    expect(normalizeToLf('zażółć\r\ngęślą')).toBe('zażółć\ngęślą');
  });

  it('jest idempotentna', () => {
    const once = normalizeToLf('a\r\nb\rc');
    expect(normalizeToLf(once)).toBe(once);
  });
});
