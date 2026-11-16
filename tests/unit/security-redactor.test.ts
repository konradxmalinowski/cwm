import { describe, expect, it } from 'vitest';

import type { DiagnosticsReport } from '../../src/core/model/diagnostics';
import {
  REPORT_LOG_LINES,
  buildReport,
  reportFileName,
} from '../../src/core/services/diagnostics/report-builder';
import {
  REDACTION_CATEGORIES,
  createReportRedactor,
} from '../../src/core/services/diagnostics/report-redactor';
import { redactSecrets } from '../../src/core/services/security/secret-redactor';
import { redactHomeInText } from '../../src/infra/logging/redact';
import { SECRETS, filler } from './security-secrets';

describe('redactSecrets', () => {
  it('zamienia znany klucz na znacznik i zostawia reszte linii', () => {
    const r = redactSecrets(`url = "https://acme.test"\nkey: ${SECRETS.openai} # komentarz\n`);
    expect(r.text).toContain('key: [ukryty sekret: known-key] # komentarz');
    expect(r.text).toContain('url = "https://acme.test"');
    expect(r.text).not.toContain(SECRETS.openai);
    expect(r.rules).toContain('known-key');
  });

  it('redaguje wartosc przypisana do klucza o nazwie wskazujacej na sekret', () => {
    const value = `${filler(10)}7${filler(10, 3)}`;
    const r = redactSecrets(`{ "ACME_API_KEY": "${value}", "ACME_NAME": "acme" }`);
    expect(r.text).not.toContain(value);
    expect(r.text).toContain('"ACME_NAME": "acme"');
    expect(r.rules).toContain('key-name');
  });

  it('redaguje dlugi ciag o wysokiej entropii', () => {
    const token = `${filler(40, 5)}9`;
    const r = redactSecrets(`Authorization przez ${token} koniec`);
    expect(r.text).toBe('Authorization przez [ukryty sekret: entropy] koniec');
  });

  it('redaguje caly blok klucza prywatnego, takze linie srodkowe', () => {
    const body = filler(64, 9);
    const r = redactSecrets(`przed\n${SECRETS.pemBegin}\n${body}\n${SECRETS.pemEnd}\npo\n`);
    expect(r.text).not.toContain(body);
    expect(r.text).not.toContain('PRIVATE KEY');
    expect(r.text.startsWith('przed\n')).toBe(true);
    expect(r.text.endsWith('\npo\n')).toBe(true);
  });

  it('plik o nazwie wskazujacej na dane logowania traci wszystkie wartosci', () => {
    const r = redactSecrets('{\n  "login": "jan",\n  "x": "abc"\n}\n', 'auth.json');
    expect(r.text).not.toContain('jan');
    expect(r.text).not.toContain('abc');
    expect(r.text).toContain('"login": [ukryty sekret: file-name]');
    expect(r.text.startsWith('{\n')).toBe(true);
    const env = redactSecrets('A=1\nB=dwa\n', 'cfg/.env');
    expect(env.text).toBe('A=[ukryty sekret: file-name]\nB=[ukryty sekret: file-name]\n');
  });

  it('zwykly tekst przechodzi bez zmian, z zachowaniem koncow linii', () => {
    const plain = '# Tytul\r\nopis skilla o tokenach i hasle\r\n- punkt\r\n';
    const r = redactSecrets(plain);
    expect(r.text).toBe(plain);
    expect(r.rules).toEqual([]);
  });
});

describe('redactHomeInText', () => {
  it('zamienia katalog domowy w srodku zdania, takze w wariancie z backslashem', () => {
    expect(redactHomeInText('blad w /home/acme/.codex/x i /home/acme', '/home/acme/')).toBe(
      'blad w ~/.codex/x i ~',
    );
    expect(redactHomeInText('C:\\Users\\acme\\a.txt', 'C:\\Users\\acme')).toBe('~\\a.txt');
    expect(redactHomeInText('bez zmian', '')).toBe('bez zmian');
  });
});

describe('redakcja raportu diagnostycznego (ADR 0053)', () => {
  const redactor = (userName: string | null = 'acme') =>
    createReportRedactor({
      redactHome: (text) => redactHomeInText(text, '/home/acme'),
      userName,
      items: [
        { kind: 'skill', names: ['acme-deploy', 'Deploy Helper'] },
        { kind: 'agent', names: ['acme-reviewer'] },
      ],
    });

  it('zamienia katalog domowy na ~ i nazwe konta na <user>', () => {
    expect(redactor().redact('blad w /home/acme/.codex/config.toml, konto acme.')).toBe(
      'blad w ~/.codex/config.toml, konto <user>.',
    );
  });

  it('pomija nazwe konta krotsza niz trzy znaki, zeby nie zjadac zwyklych slow', () => {
    expect(redactor('ab').redact('tab ab ba')).toBe('tab ab ba');
  });

  it('nazwy elementow dostaja stabilne znaczniki, jeden na element', () => {
    const r = redactor();
    const text = 'acme-deploy, Deploy Helper, acme-reviewer i znowu acme-deploy';
    expect(r.redact(text)).toBe('<skill-1>, <skill-1>, <agent-1> i znowu <skill-1>');
    expect(r.redact('acme-reviewer')).toBe('<agent-1>');
  });

  it('nazwa elementu nie trafia w srodek dluzszego slowa ani w znacznik', () => {
    const r = createReportRedactor({
      redactHome: (text) => text,
      userName: 'user',
      items: [{ kind: 'skill', names: ['deploy', 'host'] }],
    });
    expect(r.redact('redeploy a deploy, https://host.test/x')).toBe(
      'redeploy a <skill-1>, https://<host>/x',
    );
  });

  it('host w URL zamienia na <host> razem z portem i danymi logowania, sciezka zostaje', () => {
    const r = redactor();
    const out = r.redact(
      'pobrano https://jan:haslo@git.internal.test:8443/org/repo.git oraz http://10.0.0.5/x',
    );
    expect(out).toBe('pobrano https://<host>/org/repo.git oraz http://<host>/x');
    expect(r.redact('app://bundle/index.html')).toBe('app://bundle/index.html');
  });

  it('adres e-mail zamienia na <email>', () => {
    expect(redactor().redact('kontakt: jan.kowalski@acme.test.')).toBe('kontakt: <email>.');
  });

  it('sekrety przechodza przez ten sam klasyfikator co logger', () => {
    const out = redactor().redact(`klucz ${SECRETS.openai} i token ${SECRETS.github}`);
    expect(out).not.toContain(SECRETS.openai);
    expect(out).not.toContain(SECRETS.github);
    expect(out).toContain('[ukryty sekret: known-key]');
  });

  it('nieznane segmenty sciezek dostaja znaczniki, znane zostaja czytelne', () => {
    const r = redactor();
    const first = r.redact('blad w /srv/klient-x/build/out.log i ~/.claude/skills/SKILL.md');
    expect(first).not.toContain('klient-x');
    expect(first).not.toContain('build');
    expect(first).toContain('~/.claude/skills/SKILL.md');
    expect(first).toMatch(/\/<path-\d+>\/<path-\d+>\/<path-\d+>/);
    expect(r.redact('/srv/klient-x')).toBe(r.redact('/srv/klient-x'));
    expect(r.redact('/srv/klient-x')).toMatch(/^\/<path-\d+>\/<path-\d+>$/);
  });

  it('nie rusza wersji, czasu ani skrotow z ukosnikiem w srodku slowa', () => {
    const text = 'Chromium 140.0.0.0, 2026-11-16T10:00:00.000Z, TCP/IP, 3/4';
    expect(redactor().redact(text)).toBe(text);
  });
});

describe('skladanie raportu diagnostycznego', () => {
  const diagnostics: DiagnosticsReport = {
    generatedAt: '2026-01-02T03:04:05.000Z',
    runtime: {
      platform: 'linux',
      arch: 'x64',
      appVersion: '0.2.0',
      electronVersion: '44.0.0',
      chromeVersion: '140.0.0.0',
      nodeVersion: '24.0.0',
      packaged: true,
    },
    database: {
      status: 'failed',
      reason: 'blad w /home/acme/.config/CWM/index.db',
      locationLabel: 'index.db (katalog danych aplikacji)',
    },
    index: { outcome: 'refused', reason: 'corrupted', message: 'plik /home/acme/acme-deploy.db' },
    appIcon: 'provided',
    stage: 'etap-test',
  };
  const build = (logLines: readonly string[]) =>
    buildReport(
      {
        diagnostics,
        library: { total: 3, countsByKind: { skill: 2, agent: 1 }, problems: 0, inconsistent: 1 },
        tools: [
          {
            tool: 'claude-code',
            kind: 'skills',
            label: '~/.claude/skills',
            exists: true,
            active: true,
          },
        ],
        logLines,
      },
      createReportRedactor({
        redactHome: (text) => redactHomeInText(text, '/home/acme'),
        userName: 'acme',
        items: [{ kind: 'skill', names: ['acme-deploy'] }],
      }),
    );

  it('wypisuje na poczatku kazda kategorie redakcji', () => {
    const { text } = build([]);
    expect(text.startsWith('# Raport diagnostyczny CWM')).toBe(true);
    const intro = text.slice(0, text.indexOf('## Aplikacja i środowisko'));
    for (const category of REDACTION_CATEGORIES) expect(intro).toContain(category.label);
  });

  it('redaguje cala tresc: sciezki, nazwy elementow i log', () => {
    const { text } = build(['2026-01-02T00:00:00Z ERROR import acme-deploy z /home/acme/x']);
    expect(text).not.toContain('/home/acme');
    expect(text).not.toContain('acme-deploy');
    expect(text).toContain('ERROR import <skill-1> z ~/<path-1>');
  });

  it('zawiera same liczby biblioteki, wersje i liste narzedzi', () => {
    const { text } = build([]);
    expect(text).toContain('- elementów razem: 3');
    expect(text).toContain('- skill: 2');
    expect(text).toContain('- wersja aplikacji: 0.2.0');
    expect(text).toContain('- Chromium: 140.0.0.0');
    expect(text).toContain(
      '- claude-code, skills: jest, czytana przez narzędzie (~/.claude/skills)',
    );
  });

  it('bierze najwyzej ostatnie 200 linii logu i nie pozwala zamknac bloku kodu', () => {
    const lines = Array.from({ length: REPORT_LOG_LINES + 50 }, (_, i) => `linia ${i}`);
    lines[lines.length - 1] = 'koniec ``` bloku';
    const built = build(lines);
    expect(built.logLineCount).toBe(REPORT_LOG_LINES);
    expect(built.text).not.toMatch(/^linia 49$/m);
    expect(built.text).toMatch(/^linia 50$/m);
    expect(built.text).toContain("koniec ''' bloku");
    expect(built.text.match(/```/g)).toHaveLength(2);
  });

  it('mowi wprost, gdy biblioteka albo wykrywanie narzedzi byly niedostepne', () => {
    const { text } = buildReport(
      { diagnostics, library: null, tools: null, logLines: [] },
      createReportRedactor({ redactHome: (t) => t, userName: null, items: [] }),
    );
    expect(text).toContain('biblioteka była niedostępna');
    expect(text).toContain('wykrywanie lokalizacji nie powiodło się');
    expect(text).toContain('Log jest pusty albo nie istnieje.');
  });

  it('proponuje nazwe pliku z data raportu', () => {
    expect(reportFileName('2026-01-02T03:04:05.000Z')).toBe('cwm-raport-2026-01-02.md');
  });
});
