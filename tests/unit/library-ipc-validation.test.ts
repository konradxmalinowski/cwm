import { describe, expect, it } from 'vitest';

import type { LoadedItem } from '../../src/core/model/item';
import { toItemDraft } from '../../src/main/ipc/handlers/library';
import {
  parseDeleteApplyRequest,
  parseListRequest,
  parseRepairRequest,
  parseSaveRequest,
} from '../../src/main/ipc/handlers/library-validation';

import { filler } from './security-secrets';

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

describe('library:save liczy wykrycia sekretow od nowa (ADR 0060, H1)', () => {
  const dto = { ...DRAFT, kind: 'skill' as const };
  const stale = { rule: 'stara', relPath: 'body.md', line: 1 };
  const previous = (assetText: string): LoadedItem =>
    ({
      item: {
        identity: { aliases: [], declaredName: null },
        content: { description: 'D', descriptionOrigin: 'source' },
        classification: { scope: 'public', secretFindings: [stale] },
        attributes: {},
      },
      assets: [{ relPath: 'ref/notatki.txt', bytes: new TextEncoder().encode(assetText) }],
      snapshotFiles: [],
    }) as unknown as LoadedItem;

  it('sekret dopisany do tresci, tytulu albo opisu trafia do secretFindings', () => {
    expect(toItemDraft(dto, null).classification?.secretFindings).toEqual([]);
    for (const patch of [
      { body: `${['api', '_key'].join('')} = ${filler(24)}` },
      { title: `${['tok', 'en'].join('')}: ${filler(16, 3)}` },
      { description: `${['pass', 'word'].join('')}: ${filler(16, 5)}` },
    ]) {
      const findings = toItemDraft({ ...dto, ...patch }, null).classification?.secretFindings;
      expect(findings?.length, JSON.stringify(patch)).toBeGreaterThan(0);
    }
  });

  it('wykrycie zniknelo razem z sekretem, a sekret w pliku pomocniczym zostaje', () => {
    const cleaned = toItemDraft(dto, previous('zwykla notatka'));
    expect(cleaned.classification?.secretFindings).toEqual([]);
    const withAsset = toItemDraft(dto, previous(`${['tok', 'en'].join('')}: ${filler(16, 3)}`));
    expect(withAsset.classification?.secretFindings.map((f) => f.relPath)).toEqual([
      'assets/ref/notatki.txt',
    ]);
    expect(withAsset.classification?.scope).toBe('public');
  });
});
