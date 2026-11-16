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
  type RedactableItem,
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
      'redeploy a <skill-1>, https://<host>/<path-1>',
    );
  });

  it('adres URL jest redagowany w calosci: host, sciezka i zapytanie', () => {
    const r = redactor();
    const out = r.redact(
      'pobrano https://jan:haslo@git.internal.test:8443/org/repo.git oraz http://10.0.0.5/x',
    );
    expect(out).toBe('pobrano https://<host>/<path-1>/<path-2> oraz http://<host>/<path-3>');
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
      '- `claude-code`, `skills`: jest, czytana przez narzędzie (`~/.claude/skills`)',
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

describe('luki redakcji z przegladu bezpieczenstwa (ADR 0053)', () => {
  const make = (userName: string | null = null, items: RedactableItem[] = []) =>
    createReportRedactor({
      redactHome: (text) => redactHomeInText(text, '/home/acme'),
      userName,
      items,
    });

  it('SEC-001: URL jest redagowany w calosci, a file: jak sciezka', () => {
    const r = make();
    const url = r.redact('https://github.com/acme-corp/private-repo/blob/main/x?tok=1#sekcja');
    expect(url).toMatch(/^https:\/\/<host>\//);
    for (const leak of ['github', 'acme-corp', 'private-repo', 'tok=1', 'sekcja']) {
      expect(url).not.toContain(leak);
    }
    expect(r.redact('file://~/acme-secret/notes.md')).not.toMatch(/acme-secret|notes/);
    const abs = r.redact('file:///Volumes/Work/client-acme/x.md');
    expect(abs).not.toMatch(/Work|client-acme|x\.md/);
  });

  it('SEC-002: sciezka po znaczniku nazwy konta albo elementu jest redagowana dalej', () => {
    const r = make('jan', [{ kind: 'skill', names: ['acme-deploy'] }]);
    const a = r.redact('/data/home/jan/projects/acme-crm/x');
    expect(a).toContain('<user>');
    expect(a).not.toMatch(/acme-crm|projects/);
    const b = r.redact('~/.claude/skills/acme-deploy/references/acme-pricing.md');
    expect(b).toContain('<skill-1>');
    expect(b).not.toMatch(/pricing|references/);
  });

  it('SEC-003: hosty, adresy IP i host:port bez URL', () => {
    const r = make();
    expect(r.redact('getaddrinfo ENOTFOUND git.corp.example.com')).toBe(
      'getaddrinfo ENOTFOUND <host>',
    );
    expect(r.redact('connect ECONNREFUSED 10.0.0.5:5432')).toBe('connect ECONNREFUSED <ip>');
    expect(r.redact('polaczenie [fd00::1]:22 odrzucone')).toBe('polaczenie <ip> odrzucone');
    expect(r.redact('fe80::1 i 2001:db8:0:0:0:0:0:1')).toBe('<ip> i <ip>');
    expect(r.redact('db.internal.corp:5432')).toBe('<host>');
    expect(r.redact('localhost:5432')).toBe('<host>');
    // Wersje nie sa adresami.
    const versions =
      'Chrome/140.0.0.0, Chromium: 140.0.0.0, v1.2.3.4, 12:30:45, index.db, SKILL.md';
    expect(r.redact(versions)).toBe(versions);
  });

  it('SEC-004: sciezki wzgledne z separatorami', () => {
    const r = make();
    expect(r.redact('plik projects/acme-client/src/index.ts')).not.toMatch(/acme-client|index\.ts/);
    expect(r.redact('plik ../../client-acme/x')).not.toContain('client-acme');
    expect(r.redact('TCP/IP i 3/4')).toBe('TCP/IP i 3/4');
  });

  it('SEC-005: sciezka ze spacjami do ostatniego separatora, reszta zdania zostaje', () => {
    const r = make();
    const out = r.redact('plik /Users/jan/Client Acme/secret plan/x.md zniknal');
    expect(out).not.toMatch(/Client|Acme|secret|plan/);
    expect(out.endsWith(' zniknal')).toBe(true);
  });

  it('SEC-006: sciezka tuz po dwukropku', () => {
    const r = make();
    expect(r.redact('cwd:/Users/other/acme')).not.toMatch(/other|acme/);
    expect(r.redact('path:C:\\Work\\acme\\x')).not.toMatch(/Work|acme/);
  });

  it('SEC-007: zdalny adres scp w calosci', () => {
    const out = make().redact('clone git@gitlab.corp.com:acme/internal-repo.git nie dziala');
    expect(out).toBe('clone <host> nie dziala');
  });

  it('SEC-008: nazwy z separatorami na brzegu, nazwa rowna znanemu katalogowi, obciecie listy', () => {
    const r = make(null, [{ kind: 'skill', names: ['acme-deploy', 'acme_helper', 'skills'] }]);
    expect(r.redact('acme-deploy-v2 i acme_helper_v2 oraz skills')).toBe(
      '<skill-1>-v2 i <skill-1>_v2 oraz <skill-1>',
    );
    const many = Array.from({ length: 5001 }, (_, i) => ({
      kind: 'skill',
      names: [`element-${String(i).padStart(5, '0')}`],
    }));
    expect(make(null, many).warnings).toHaveLength(1);
    expect(r.warnings).toEqual([]);
  });

  it('SEC-009: katalog domowy tylko z granica, wielkosc liter, JSON i kodowanie URL', () => {
    expect(redactHomeInText('/Users/janusz/x i /Users/jan/x', '/Users/jan', 'linux')).toBe(
      '/Users/janusz/x i ~/x',
    );
    expect(redactHomeInText('/srv/home/acme/x', '/home/acme', 'linux')).toBe('/srv/home/acme/x');
    expect(redactHomeInText('c:\\users\\JAN\\x', 'C:\\Users\\jan', 'win32')).toBe('~\\x');
    expect(redactHomeInText('c:\\users\\JAN\\x', 'C:\\Users\\jan', 'linux')).toContain('JAN');
    expect(redactHomeInText('"C:\\\\Users\\\\jan\\\\x"', 'C:\\Users\\jan', 'win32')).toBe(
      '"~\\\\x"',
    );
    expect(redactHomeInText('file:///Users/my%20name/x', '/Users/my name', 'linux')).toBe(
      'file://~/x',
    );
  });

  it('SEC-010: linia logu jest skracana po redakcji, wiec sekret nie zostaje w ogonie', () => {
    const line = `${'a'.repeat(580)} ${SECRETS.openai}`;
    const { text } = buildReport(
      {
        diagnostics: {
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
          database: { status: 'unavailable', reason: 'ping @maintainer see #123' },
          index: { outcome: 'refused', message: 'zobacz [link](http://e.test/x) @kto' },
          appIcon: 'provided',
          stage: 'etap-test',
        },
        library: null,
        tools: null,
        logLines: [line],
      },
      make(),
    );
    expect(text).not.toContain(SECRETS.openai.slice(0, 10));
    expect(text).toContain('[ukryty sekret: known-key]'.slice(0, 12));
    // Pola spoza bloku logu sa w znacznikach kodu: bez wzmianek i linkow w publicznym zgloszeniu.
    expect(text).toContain('- powód: `ping @maintainer see #123`');
    expect(text).toMatch(/- komunikat: `zobacz \[link\]\(<?[^`]*@kto`/);
  });
});
