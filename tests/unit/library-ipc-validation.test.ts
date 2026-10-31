import { describe, expect, it } from 'vitest';

import {
  parseDeleteApplyRequest,
  parseListRequest,
  parseRepairRequest,
  parseSaveRequest,
} from '../../src/main/ipc/handlers/library-validation';

const ID = '01JBZ3N5V0ABCDEFGHJKMNPQRS';
const DRAFT = { kind: 'skill', slug: 'acme-skill', title: 'T', description: 'D', body: 'B' };

describe('walidacja ladunkow library:*', () => {
  it('lista przyjmuje brak ladunku i odrzuca zly ksztalt', () => {
    expect(parseListRequest(undefined)).toEqual({ ok: true, value: {} });
    expect(parseListRequest({ kind: 'nie-ma' }).ok).toBe(false);
    expect(parseListRequest('x').ok).toBe(false);
    expect(parseListRequest({ query: 5 }).ok).toBe(false);
  });

  it('zapis odrzuca zle id i nieznany rodzaj, a nieznane pola gubi', () => {
    expect(parseSaveRequest({ draft: DRAFT })).toEqual({ ok: true, value: { draft: DRAFT } });
    expect(parseSaveRequest({ id: 'zle', draft: DRAFT }).ok).toBe(false);
    expect(parseSaveRequest({ draft: { ...DRAFT, kind: 'x' } }).ok).toBe(false);
    expect(parseSaveRequest({ draft: { ...DRAFT, evil: 1 } })).toEqual({
      ok: true,
      value: { draft: DRAFT },
    });
    expect(parseSaveRequest(null).ok).toBe(false);
  });

  it('naprawa wymaga znanej akcji, usuniecie tokenu', () => {
    expect(parseRepairRequest({ id: ID, action: 'adopt-disk' }).ok).toBe(true);
    expect(parseRepairRequest({ id: ID, action: 'drop' }).ok).toBe(false);
    expect(parseDeleteApplyRequest({ token: '' }).ok).toBe(false);
    expect(parseDeleteApplyRequest({ token: 't', acknowledgeUnrecoverable: 'tak' }).ok).toBe(false);
  });
});
