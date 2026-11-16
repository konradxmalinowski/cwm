import { describe, expect, it } from 'vitest';

import type { DatabaseProbe, RuntimeInfo } from '../../src/core/model/diagnostics';
import type { IndexStore } from '../../src/core/ports/index-store';
import { buildDiagnosticsReport } from '../../src/main/services/diagnostics';
import { AtomicWriteError } from '../../src/infra/fs/atomic';
import { redactHomeInText, redactHomePath } from '../../src/infra/logging/redact';
import type { ListResult } from '../../src/core/services/library/library-service';
import {
  DiagnosticReportService,
  PREVIEW_TTL_MS,
  type DiagnosticReportDeps,
} from '../../src/main/services/diagnostic-report';
import { parseReportSaveRequest } from '../../src/main/ipc/handlers/diagnostics-validation';

const runtime: RuntimeInfo = {
  platform: 'darwin',
  arch: 'arm64',
  appVersion: '0.1.0',
  electronVersion: '44.0.0',
  chromeVersion: '140.0.0.0',
  nodeVersion: '24.0.0',
  packaged: false,
};

function storeReturning(probe: DatabaseProbe): IndexStore {
  return {
    probe: () => probe,
    close: () => undefined,
  };
}

describe('raport diagnostyczny', () => {
  it('bierze czas z wstrzyknietego zegara', () => {
    const report = buildDiagnosticsReport({
      runtime,
      indexStore: storeReturning({ status: 'failed', reason: 'brak', locationLabel: '~/x' }),
      index: { outcome: 'ready' },
      clock: { now: () => new Date('2026-01-02T03:04:05.000Z') },
      appIcon: 'placeholder',
      stage: 'etap-1-szkielet',
    });
    expect(report.generatedAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('nie ukrywa, ze ikona jest placeholderem', () => {
    const report = buildDiagnosticsReport({
      runtime,
      indexStore: storeReturning({ status: 'failed', reason: 'brak', locationLabel: '~/x' }),
      index: { outcome: 'ready' },
      clock: { now: () => new Date(0) },
      appIcon: 'placeholder',
      stage: 'etap-1-szkielet',
    });
    expect(report.appIcon).toBe('placeholder');
  });

  it('przepuszcza nieudana probe bazy jako jawny status, nie jako brak danych', () => {
    const report = buildDiagnosticsReport({
      runtime,
      indexStore: storeReturning({
        status: 'failed',
        reason: 'NODE_MODULE_VERSION mismatch',
        locationLabel: '~/Library/x/index.db',
      }),
      index: { outcome: 'ready' },
      clock: { now: () => new Date(0) },
      appIcon: 'placeholder',
      stage: 'etap-1-szkielet',
    });
    expect(report.database.status).toBe('failed');
  });
});

describe('raport nie zawiera sciezek', () => {
  it('etykieta, kwarantanna i komunikaty nie niosa katalogu domowego ani userData', () => {
    const report = buildDiagnosticsReport({
      runtime,
      indexStore: storeReturning({
        status: 'failed',
        reason: 'blad w /private/tmp/acme-userdata/index.db',
        locationLabel: '/private/tmp/acme-userdata/index.db',
      }),
      index: {
        outcome: 'rebuilt',
        message: 'katalog indeksu ~/Library/acme/index.db nie jest zapisywalny',
        quarantinedAs: '~/Library/acme/quarantine/index-1.sqlite',
        notRestored: ['plik C:\\Users\\acme\\x.db'],
      },
      clock: { now: () => new Date(0) },
      appIcon: 'placeholder',
      stage: 'etap-2-biblioteka',
    });
    const json = JSON.stringify(report);
    expect(json).not.toContain('/private/tmp');
    expect(json).not.toContain('Library/acme');
    expect(json).not.toContain('Users');
    expect(report.index.quarantinedAs).toBe('index-1.sqlite');
    expect(report.database).toMatchObject({ locationLabel: 'index.db (katalog danych aplikacji)' });
  });

  it('niedostepny indeks tez nie wypuszcza sciezki', () => {
    const report = buildDiagnosticsReport({
      runtime,
      indexStore: null,
      index: { outcome: 'refused', message: 'brak zapisu w /home/acme/.config/app' },
      clock: { now: () => new Date(0) },
      appIcon: 'placeholder',
      stage: 'etap-2-biblioteka',
    });
    expect(JSON.stringify(report)).not.toContain('/home/acme');
  });
});

describe('redakcja sciezek', () => {
  it('zamienia katalog domowy na ~', () => {
    expect(redactHomePath('/home/acme/.local/app/index.db', '/home/acme')).toBe(
      '~/.local/app/index.db',
    );
  });

  it('zostawia sciezke poza katalogiem domowym bez zmian', () => {
    expect(redactHomePath('/opt/acme/index.db', '/home/acme')).toBe('/opt/acme/index.db');
  });

  it('radzi sobie ze separatorem Windowsa', () => {
    expect(redactHomePath('C:\\Users\\acme\\AppData\\index.db', 'C:\\Users\\acme')).toBe(
      '~\\AppData\\index.db',
    );
  });

  it('nie wycina nazwy konta z podobnego prefiksu', () => {
    expect(redactHomePath('/home/acme', '/home/acme')).toBe('~');
  });
});

describe('eksport raportu do zgloszenia (ADR 0053)', () => {
  const diagnostics = buildDiagnosticsReport({
    runtime,
    indexStore: null,
    index: { outcome: 'refused', message: 'brak zapisu w /home/acme/.config/CWM' },
    clock: { now: () => new Date('2026-01-02T03:04:05.000Z') },
    appIcon: 'provided',
    stage: 'etap-test',
  });
  const listing = {
    items: [
      {
        kind: 'skill',
        identity: { slug: 'acme-deploy', declaredName: null, aliases: [] },
        content: { title: 'Deploy Helper' },
      },
    ],
    problems: [],
    inconsistent: [],
  } as unknown as ListResult;

  function setup(over: Partial<DiagnosticReportDeps> = {}) {
    const writes: { path: string; text: string }[] = [];
    let now = new Date('2026-01-02T03:04:05.000Z').getTime();
    let nextId = 0;
    const deps: DiagnosticReportDeps = {
      diagnostics: () => Promise.resolve(diagnostics),
      list: () => Promise.resolve(listing),
      detect: () => Promise.resolve([]),
      readLog: () => [
        '2026-01-02T00:00:00Z ERROR import acme-deploy z /home/acme/.codex/config.toml',
      ],
      redactHome: (text) => redactHomeInText(text, '/home/acme'),
      userName: 'acme',
      clock: { now: () => new Date(now) },
      newId: () => `id-${++nextId}`,
      pickPath: () => Promise.resolve('/tmp/acme-out/raport'),
      writeFile: (path, text) => {
        writes.push({ path, text });
        return Promise.resolve();
      },
      protectedRoots: ['/home/acme/.claude', '/home/acme/.codex'],
      logUnexpected: () => undefined,
      ...over,
    };
    return {
      service: new DiagnosticReportService(deps),
      writes,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('podglad jest zredagowany i niesie identyfikator oraz nazwe pliku', async () => {
    const { service } = setup();
    const result = await service.preview();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.previewId).toBe('id-1');
    expect(result.value.fileName).toBe('cwm-raport-2026-01-02.md');
    expect(result.value.logLineCount).toBe(1);
    expect(result.value.text).not.toContain('/home/acme');
    expect(result.value.text).not.toContain('acme-deploy');
    expect(result.value.text).toContain('ERROR import <skill-1> z ~/.codex/config.toml');
  });

  it('zapis daje dokladnie te tresc, ktora pokazal podglad, i dopisuje .md', async () => {
    const { service, writes } = setup();
    const preview = await service.preview();
    if (!preview.ok) throw new Error('brak podgladu');
    const saved = await service.save(preview.value.previewId);
    expect(saved).toEqual({ ok: true, value: { status: 'saved', fileName: 'raport.md' } });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.text).toBe(preview.value.text);
    expect(writes[0]?.path).toMatch(/raport\.md$/);
    const again = await service.save(preview.value.previewId);
    expect(again).toMatchObject({ ok: false, error: { code: 'preview-expired' } });
  });

  it('zamkniecie okna zapisu niczego nie zapisuje i zostawia podglad do ponowienia', async () => {
    let answer: string | null = null;
    const { service, writes } = setup({ pickPath: () => Promise.resolve(answer) });
    const preview = await service.preview();
    if (!preview.ok) throw new Error('brak podgladu');
    expect(await service.save(preview.value.previewId)).toEqual({
      ok: true,
      value: { status: 'cancelled' },
    });
    expect(writes).toEqual([]);
    answer = '/tmp/acme-out/raport.txt';
    const saved = await service.save(preview.value.previewId);
    expect(saved).toEqual({ ok: true, value: { status: 'saved', fileName: 'raport.txt' } });
  });

  it('odmawia zapisu w katalogu konfiguracji narzedzia', async () => {
    const { service, writes } = setup({
      pickPath: () => Promise.resolve('/home/acme/.claude/skills/raport.md'),
    });
    const preview = await service.preview();
    if (!preview.ok) throw new Error('brak podgladu');
    const saved = await service.save(preview.value.previewId);
    expect(saved).toMatchObject({ ok: false, error: { code: 'forbidden-location' } });
    expect(writes).toEqual([]);
  });

  it('nieznany i wygasly podglad daja preview-expired', async () => {
    const { service, advance } = setup();
    expect(await service.save('nie-ma')).toMatchObject({
      ok: false,
      error: { code: 'preview-expired' },
    });
    const preview = await service.preview();
    if (!preview.ok) throw new Error('brak podgladu');
    advance(PREVIEW_TTL_MS + 1);
    expect(await service.save(preview.value.previewId)).toMatchObject({
      ok: false,
      error: { code: 'preview-expired' },
    });
  });

  it('blad zapisu nie wypuszcza sciezki do renderera', async () => {
    const { service } = setup({
      writeFile: () =>
        Promise.reject(
          new AtomicWriteError(
            'permission-denied',
            'unknown',
            'brak uprawnien do zapisu: /home/acme/Documents/raport.md',
          ),
        ),
    });
    const preview = await service.preview();
    if (!preview.ok) throw new Error('brak podgladu');
    const saved = await service.save(preview.value.previewId);
    expect(saved).toMatchObject({ ok: false, error: { code: 'permission-denied' } });
    expect(JSON.stringify(saved)).not.toContain('/home/acme');
  });

  it('raport powstaje takze bez biblioteki i bez wykrywania narzedzi', async () => {
    const { service } = setup({ list: () => null, detect: () => Promise.reject(new Error('x')) });
    const result = await service.preview();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toContain('biblioteka była niedostępna');
      expect(result.value.text).toContain('wykrywanie lokalizacji nie powiodło się');
    }
  });

  it('parser zapisu przyjmuje tylko previewId i odrzuca sciezki oraz nadmiar', () => {
    expect(
      parseReportSaveRequest({ previewId: 'a1b2-c3', path: '/etc/passwd', text: 'x' }),
    ).toEqual({ ok: true, value: { previewId: 'a1b2-c3' } });
    expect(parseReportSaveRequest({ previewId: 'a'.repeat(64) }).ok).toBe(true);
    expect(parseReportSaveRequest({ previewId: 'a'.repeat(65) }).ok).toBe(false);
    expect(parseReportSaveRequest({ previewId: '../../etc/passwd' }).ok).toBe(false);
    expect(parseReportSaveRequest({ previewId: '' }).ok).toBe(false);
    expect(parseReportSaveRequest({}).ok).toBe(false);
    expect(parseReportSaveRequest(null).ok).toBe(false);
    expect(parseReportSaveRequest('id').ok).toBe(false);
  });
});
