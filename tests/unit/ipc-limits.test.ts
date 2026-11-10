import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

import { MAX_PLAN_ITEMS } from '../../src/core/services/export/export-service';
import { MAX_PREVIEW_BYTES, previewText } from '../../src/main/ipc/handlers/export';
import { parsePlanRequest } from '../../src/main/ipc/handlers/export-validation';
import { parseApplyRequest, parseScanRequest } from '../../src/main/ipc/handlers/import-validation';
import { parseListRequest } from '../../src/main/ipc/handlers/library-validation';
import { exportHarness } from './export-fakes';

/**
 * Limity na granicy IPC i w eksporcie (ARCHITECTURE 12.5): kazdy ma test, ze dokladnie limit
 * przechodzi, a limit + 1 nie. Wartosci sa przepisane z kodu celowo: zmiana limitu ma byc
 * swiadoma i widoczna w tym tescie.
 */

const ids = (n: number, length = 26): string[] =>
  Array.from({ length: n }, (_, i) => `${i}`.padStart(length, 'A'));

describe('limity ladunkow IPC: limit przechodzi, limit + 1 nie', () => {
  it('export:plan: 500 elementow i id do 128 znakow', () => {
    expect(parsePlanRequest({ tool: 'codex', itemIds: ids(500) }).ok).toBe(true);
    expect(parsePlanRequest({ tool: 'codex', itemIds: ids(501) }).ok).toBe(false);
    expect(parsePlanRequest({ tool: 'codex', itemIds: ids(1, 128) }).ok).toBe(true);
    expect(parsePlanRequest({ tool: 'codex', itemIds: ids(1, 129) }).ok).toBe(false);
  });

  it('library:list: zapytanie do 256 znakow', () => {
    expect(parseListRequest({ query: 'a'.repeat(256) }).ok).toBe(true);
    expect(parseListRequest({ query: 'a'.repeat(257) }).ok).toBe(false);
  });

  it('import:scan do 32 rootow, import:apply do 5000 kandydatow', () => {
    expect(parseScanRequest({ rootIds: ids(32) }).ok).toBe(true);
    expect(parseScanRequest({ rootIds: ids(33) }).ok).toBe(false);
    const token = 't'.repeat(128);
    expect(parseApplyRequest({ scanToken: token, candidateIds: ids(5000) }).ok).toBe(true);
    expect(parseApplyRequest({ scanToken: token, candidateIds: ids(5001) }).ok).toBe(false);
    expect(parseApplyRequest({ scanToken: `${token}t`, candidateIds: [] }).ok).toBe(false);
  });
});

describe('podglad pliku w planie eksportu (MAX_PREVIEW_BYTES)', () => {
  it('tekst o rozmiarze limitu jest pokazany, limit + 1 i bajt NUL juz nie', () => {
    expect(MAX_PREVIEW_BYTES).toBe(256 * 1024);
    const atLimit = new Uint8Array(MAX_PREVIEW_BYTES).fill(0x61);
    expect(previewText(atLimit)?.length).toBe(MAX_PREVIEW_BYTES);
    expect(previewText(new Uint8Array(MAX_PREVIEW_BYTES + 1).fill(0x61))).toBeNull();
    expect(previewText(new Uint8Array([0x61, 0x00, 0x62]))).toBeNull();
    expect(previewText(new TextEncoder().encode('zażółć 日本'))).toBe('zażółć 日本');
  });
});

describe('ExportService: liczba elementow w jednym planie (MAX_PLAN_ITEMS)', () => {
  it('ponad limit to odmowa no-items, a limit z duplikatami przechodzi przez licznik', async () => {
    expect(MAX_PLAN_ITEMS).toBe(500);
    const h = await exportHarness();
    await expect(h.service.plan('claude-code', ids(MAX_PLAN_ITEMS + 1))).rejects.toMatchObject({
      code: 'no-items',
    });
    // Duplikaty licza sie raz: 600 razy to samo id to jeden element i plan powstaje.
    const report = await h.service.plan('claude-code', Array(600).fill(h.itemId) as string[]);
    expect(report.items.map((i) => i.itemId)).toEqual([h.itemId]);
    // Dokladnie limit nie jest odrzucany licznikiem: pada dopiero na nieznanym elemencie.
    await expect(h.service.plan('claude-code', ids(MAX_PLAN_ITEMS))).rejects.not.toMatchObject({
      code: 'no-items',
    });
  });
});
