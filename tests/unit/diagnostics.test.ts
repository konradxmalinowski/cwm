import { describe, expect, it, vi } from 'vitest';

import type { DatabaseProbe, RuntimeInfo } from '../../src/core/model/diagnostics';
import type { IndexStore } from '../../src/core/ports/index-store';
import { buildDiagnosticsReport } from '../../src/main/services/diagnostics';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readLogTail } from '../../src/infra/logging/read-tail';
import { AtomicWriteError } from '../../src/infra/fs/atomic';
import { redactHomeInText, redactHomePath } from '../../src/infra/logging/redact';
import type { ListResult } from '../../src/core/services/library/library-service';
import {
  DiagnosticReportService,
  PREVIEW_TTL_MS,
  type DiagnosticReportDeps,
} from '../../src/main/services/diagnostic-report';
import { parseReportSaveRequest } from '../../src/main/ipc/handlers/diagnostics-validation';
import type { OperationRecord } from '../../src/core/ports/operation-log';
import { ExportError } from '../../src/core/services/export/export-service';
import type {
  ZipExportService,
  ZipPayload,
} from '../../src/core/services/export/zip-export-service';
import { ZipSaveService, type ZipSaveDeps } from '../../src/main/services/zip-export';

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
      exists: () => false,
      realpath: (path) => path,
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

  it('SEC-012: rozszerzenie dopisane po oknie zapisu nie nadpisuje istniejacego pliku', async () => {
    const { service, writes } = setup({ exists: (path) => path.endsWith('raport.md') });
    const preview = await service.preview();
    if (!preview.ok) throw new Error('brak podgladu');
    const saved = await service.save(preview.value.previewId);
    expect(saved).toMatchObject({ ok: false, error: { code: 'target-exists' } });
    expect(writes).toEqual([]);
  });

  it('SEC-012: dowiazanie do katalogu konfiguracji jest rozwijane przed sprawdzeniem', async () => {
    const { service, writes } = setup({
      pickPath: () => Promise.resolve('/tmp/acme-out/link/raport.md'),
      realpath: (path) => (path === '/tmp/acme-out/link' ? '/home/acme/.codex/skills' : path),
    });
    const preview = await service.preview();
    if (!preview.ok) throw new Error('brak podgladu');
    const saved = await service.save(preview.value.previewId);
    expect(saved).toMatchObject({ ok: false, error: { code: 'forbidden-location' } });
    expect(writes).toEqual([]);
  });

  it('SEC-013: rownolegle i szybko powtorzone podglady dziela jeden odczyt', async () => {
    let reads = 0;
    const { service } = setup({
      readLog: () => {
        reads += 1;
        return [];
      },
    });
    const [a, b] = await Promise.all([service.preview(), service.preview()]);
    const c = await service.preview();
    expect(reads).toBe(1);
    expect(a).toEqual(b);
    expect(c).toEqual(a);
  });
});

describe('odczyt konca logu (SEC-011)', () => {
  function tempDir(): string {
    return mkdtempSync(join(tmpdir(), 'cwm-log-tail-'));
  }

  it('zwraca ostatnie linie i dopelnia z pliku po rotacji', () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'app.log.1'), 'stara 1\nstara 2\n');
      writeFileSync(join(dir, 'app.log'), 'nowa 1\n\nnowa 2\n');
      expect(readLogTail(join(dir, 'app.log'), 3)).toEqual(['stara 2', 'nowa 1', 'nowa 2']);
      expect(readLogTail(join(dir, 'brak.log'), 3)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('czyta tylko koncowke duzego pliku i nie zwraca urwanej pierwszej linii', () => {
    const dir = tempDir();
    try {
      const lines = Array.from({ length: 40_000 }, (_, i) => `linia ${i}`);
      writeFileSync(join(dir, 'app.log'), `${lines.join('\n')}\n`);
      const tail = readLogTail(join(dir, 'app.log'), 5);
      expect(tail).toEqual(lines.slice(-5));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('odmawia katalogu i dowiazania zamiast zwyklego pliku', () => {
    const dir = tempDir();
    try {
      mkdirSync(join(dir, 'app.log'));
      expect(readLogTail(join(dir, 'app.log'), 3)).toEqual([]);
      if (process.platform !== 'win32') {
        writeFileSync(join(dir, 'prawdziwy.log'), 'tajne\n');
        symlinkSync(join(dir, 'prawdziwy.log'), join(dir, 'link.log'));
        expect(readLogTail(join(dir, 'link.log'), 3)).toEqual([]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('zapis archiwum ZIP (ADR 0054)', () => {
  const payload: ZipPayload = {
    planId: 'zip-1',
    items: [],
    tool: 'claude-code',
    fileName: 'cwm-export-claude-code-20261116-100000.zip',
    bytes: new Uint8Array([80, 75, 3, 4]),
    fileCount: 2,
    itemCount: 1,
  };

  function setup(over: Partial<ZipSaveDeps> = {}) {
    const writes: { path: string; bytes: Uint8Array }[] = [];
    const consumed: string[] = [];
    const records: OperationRecord[] = [];
    const picked: string[] = [];
    const leftovers: string[] = [];
    const stale = { value: false };
    const service = {
      peek: (id: string) => {
        if (id !== payload.planId) throw new ExportError('unknown-plan', 'Nieznany plan.');
        return payload;
      },
      consume: (id: string) => consumed.push(id),
      verify: (id: string) => {
        if (id !== payload.planId) throw new ExportError('unknown-plan', 'Nieznany plan.');
        if (stale.value) throw new ExportError('zip-stale', 'Element zmienił się.');
        return Promise.resolve();
      },
      plan: vi.fn(),
    } as unknown as ZipExportService;
    const deps: ZipSaveDeps = {
      service: () => service,
      pickPath: (name) => {
        picked.push(name);
        return Promise.resolve('/tmp/acme-out/archiwum.zip');
      },
      writeFile: (path, bytes) => {
        writes.push({ path, bytes });
        return Promise.resolve();
      },
      exists: () => false,
      realpath: (path) => path,
      protectedRoots: ['/home/acme/.claude', '/home/acme/.codex', '/home/acme/.config/CWM'],
      enterWrite: () => () => undefined,
      logLeftover: (name) => leftovers.push(name),
      log: {
        append: (record) => {
          records.push(record);
          return Promise.resolve();
        },
      },
      clock: { now: () => new Date('2026-11-16T10:00:00.000Z') },
      logUnexpected: () => undefined,
      ...over,
    };
    return { save: new ZipSaveService(deps), writes, consumed, records, picked, leftovers, stale };
  }

  it('zapisuje archiwum z planu, zuzywa plan i dopisuje do historii liczby bez sciezki', async () => {
    const { save, writes, consumed, records, picked } = setup();
    const result = await save.save('zip-1');
    expect(result).toEqual({
      ok: true,
      value: { status: 'saved', fileName: 'archiwum.zip', fileCount: 2 },
    });
    expect(picked).toEqual([payload.fileName]);
    expect(writes).toEqual([{ path: '/tmp/acme-out/archiwum.zip', bytes: payload.bytes }]);
    expect(consumed).toEqual(['zip-1']);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ operation: 'export-zip', before: null, after: null });
    expect(records[0]?.note).toContain('pliki=2');
    expect(records[0]?.backupId).toBeUndefined();
    expect(JSON.stringify(records)).not.toContain('/tmp');
    expect(JSON.stringify(result)).not.toContain('/tmp');
  });

  it('zamkniecie okna zapisu niczego nie zapisuje i zostawia plan do ponowienia', async () => {
    const { save, writes, consumed, records } = setup({ pickPath: () => Promise.resolve(null) });
    expect(await save.save('zip-1')).toEqual({ ok: true, value: { status: 'cancelled' } });
    expect(writes).toEqual([]);
    expect(consumed).toEqual([]);
    expect(records).toEqual([]);
  });

  it('nieznany plan: odmowa przed oknem zapisu', async () => {
    const { save, picked } = setup();
    expect(await save.save('inny')).toMatchObject({ ok: false, error: { code: 'unknown-plan' } });
    expect(picked).toEqual([]);
  });

  it('odmawia zapisu w katalogach konfiguracji narzedzi i danych aplikacji, takze przez dowiazanie', async () => {
    for (const chosen of [
      '/home/acme/.claude/skills/a.zip',
      '/home/acme/.codex/a.zip',
      '/home/acme/.config/CWM/a.zip',
    ]) {
      const { save, writes } = setup({ pickPath: () => Promise.resolve(chosen) });
      expect(await save.save('zip-1')).toMatchObject({
        ok: false,
        error: { code: 'forbidden-location' },
      });
      expect(writes).toEqual([]);
    }
    const linked = setup({
      pickPath: () => Promise.resolve('/tmp/acme-out/link/a.zip'),
      realpath: (path) => (path === '/tmp/acme-out/link' ? '/home/acme/.codex/skills' : path),
    });
    expect(await linked.save.save('zip-1')).toMatchObject({
      ok: false,
      error: { code: 'forbidden-location' },
    });
    expect(linked.writes).toEqual([]);
  });

  it('rozszerzenie dopisane po oknie zapisu nie nadpisuje istniejacego pliku', async () => {
    const { save, writes } = setup({
      pickPath: () => Promise.resolve('/tmp/acme-out/archiwum'),
      exists: (path) => path.endsWith('archiwum.zip'),
    });
    expect(await save.save('zip-1')).toMatchObject({ ok: false, error: { code: 'target-exists' } });
    expect(writes).toEqual([]);

    const fresh = setup({ pickPath: () => Promise.resolve('/tmp/acme-out/archiwum') });
    expect(await fresh.save.save('zip-1')).toMatchObject({
      ok: true,
      value: { fileName: 'archiwum.zip' },
    });
  });

  it('blad zapisu atomowego daje komunikat bez sciezki, a plan zostaje do ponowienia', async () => {
    const { save, consumed, records } = setup({
      writeFile: () =>
        Promise.reject(
          new AtomicWriteError('no-space', 'unknown', 'brak miejsca: /tmp/acme-out/archiwum.zip'),
        ),
    });
    const result = await save.save('zip-1');
    expect(result).toMatchObject({ ok: false, error: { code: 'no-space' } });
    expect(JSON.stringify(result)).not.toContain('/tmp');
    expect(consumed).toEqual([]);
    expect(records).toEqual([]);
  });

  it('awaria logu historii nie zamienia udanego zapisu w blad', async () => {
    const unexpected: unknown[] = [];
    const { save, consumed } = setup({
      log: { append: () => Promise.reject(new Error('indeks niedostepny')) },
      logUnexpected: (e) => unexpected.push(e),
    });
    expect(await save.save('zip-1')).toMatchObject({ ok: true, value: { status: 'saved' } });
    expect(consumed).toEqual(['zip-1']);
    expect(unexpected).toHaveLength(1);
  });

  it('blokada zapisow jest brana dopiero po oknie zapisu i zwalniana po zapisie', async () => {
    const events: string[] = [];
    const { save } = setup({
      pickPath: () => {
        events.push('okno');
        return Promise.resolve('/tmp/acme-out/archiwum.zip');
      },
      enterWrite: () => {
        events.push('blokada');
        return () => events.push('zwolniona');
      },
      writeFile: () => {
        events.push('zapis');
        return Promise.resolve();
      },
    });
    await save.save('zip-1');
    expect(events).toEqual(['okno', 'blokada', 'zapis', 'zwolniona']);
  });

  it('trwajaca odbudowa indeksu: odpowiedz busy i nic nie zapisane', async () => {
    const { save, writes } = setup({ enterWrite: () => null });
    expect(await save.save('zip-1')).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(writes).toEqual([]);
  });

  it('element zmieniony albo plan wygasly w trakcie okna zapisu: odmowa przed zapisem', async () => {
    const { save, writes, stale, consumed } = setup({
      pickPath: () => {
        stale.value = true;
        return Promise.resolve('/tmp/acme-out/archiwum.zip');
      },
    });
    expect(await save.save('zip-1')).toMatchObject({ ok: false, error: { code: 'zip-stale' } });
    expect(writes).toEqual([]);
    expect(consumed).toEqual([]);
  });

  it('plik tymczasowy pozostawiony po bledzie zapisu trafia do logu z nazwa, bez katalogu', async () => {
    const failure = new AtomicWriteError('io', 'unknown', 'blad zapisu');
    failure.leftover = { name: '.archiwum.zip.1.abc123.tmp', cause: new Error('rm') };
    const { save, leftovers } = setup({ writeFile: () => Promise.reject(failure) });
    expect(await save.save('zip-1')).toMatchObject({ ok: false });
    expect(leftovers).toEqual(['.archiwum.zip.1.abc123.tmp']);
  });

  it('bez serwisu eksportu plan i zapis odpowiadaja bledem eksportu', async () => {
    const { save } = setup({ service: () => null });
    expect(await save.plan('claude-code', ['x'], []).catch((e: unknown) => e)).toMatchObject({
      code: 'export-unavailable',
    });
    expect(await save.save('zip-1')).toMatchObject({
      ok: false,
      error: { code: 'export-unavailable' },
    });
  });
});
