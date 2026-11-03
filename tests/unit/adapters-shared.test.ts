import { describe, expect, it } from 'vitest';

import { parseFrontmatter } from '../../src/adapters/shared/frontmatter';
import { deriveDescription, deriveSlug, firstHeading } from '../../src/adapters/shared/slug';
import { readToml, tomlToJson } from '../../src/adapters/shared/toml';
import { validateSlug } from '../../src/core/services/library/validate';

const fm = (lines: string[], body = 'Body\n') =>
  parseFrontmatter(['---', ...lines, '---', body].join('\n'));

describe('parseFrontmatter', () => {
  it('brak ogrodzenia to brak frontmattera, a tresc zostaje cala', () => {
    const r = parseFrontmatter('# Tytul\n\nTekst\n');
    expect(r.present).toBe(false);
    expect(r.body).toBe('# Tytul\n\nTekst\n');
    expect(r.data.size).toBe(0);
  });

  it('czyta skalary, liczby, wartosci logiczne i null', () => {
    const r = fm([
      'name: acme',
      'count: 3',
      'ratio: 1.5',
      'on: true',
      'off: FALSE',
      'nothing: ~',
      'empty:',
    ]);
    expect(Object.fromEntries(r.data)).toEqual({
      name: 'acme',
      count: 3,
      ratio: 1.5,
      on: true,
      off: false,
      nothing: null,
      empty: null,
    });
    expect(r.body).toBe('Body\n');
  });

  it('czyta lancuchy w cudzyslowach z ucieczkami i dwukropkami', () => {
    const r = fm([
      'a: "line\\nbreak \\"q\\" \\u0041"',
      "b: 'it''s: fine'",
      'c: "with # hash"',
      'd: plain # comment',
    ]);
    expect(r.data.get('a')).toBe('line\nbreak "q" A');
    expect(r.data.get('b')).toBe("it's: fine");
    expect(r.data.get('c')).toBe('with # hash');
    expect(r.data.get('d')).toBe('plain');
  });

  it('czyta bloki literalne i zwiniete z chomping', () => {
    const r = fm([
      'lit: |',
      '  one',
      '    two',
      '  three',
      'fold: >',
      '  a',
      '  b',
      '',
      '  c',
      'strip: |-',
      '  x',
      'keep: |+',
      '  y',
      '',
    ]);
    expect(r.data.get('lit')).toBe('one\n  two\nthree\n');
    expect(r.data.get('fold')).toBe('a b\nc\n');
    expect(r.data.get('strip')).toBe('x');
    expect(r.data.get('keep')).toBe('y\n\n');
  });

  it('czyta listy blokowe, w klamrach kwadratowych i myslnik w kolumnie zero', () => {
    const r = fm(['a:', '  - one', '  - "two words"', 'b: [x, "y z", 3]', 'c:', '- p', '- q']);
    expect(r.data.get('a')).toEqual(['one', 'two words']);
    expect(r.data.get('b')).toEqual(['x', 'y z', 3]);
    expect(r.data.get('c')).toEqual(['p', 'q']);
  });

  it('zwija zwykly skalar zawijany na kolejne linie', () => {
    const r = fm(['description: first part', '  second part']);
    expect(r.data.get('description')).toBe('first part second part');
  });

  it('konstrukcje spoza zakresu laduja w unsupported i nie wywracaja parsera', () => {
    const r = fm([
      'nested:',
      '  a: 1',
      '  b: 2',
      'anchor: &x value',
      'alias: *x',
      'tagged: !!str 5',
      'flow: {a: 1}',
      'ok: fine',
    ]);
    expect(r.unsupported.map((u) => u.key)).toEqual([
      'nested',
      'anchor',
      'alias',
      'tagged',
      'flow',
    ]);
    expect(r.unsupported[0]?.raw).toContain('a: 1');
    expect(r.data.get('ok')).toBe('fine');
  });

  it('zdublowany klucz: obowiazuje ostatni, z ostrzezeniem', () => {
    const r = fm(['a: 1', 'a: 2']);
    expect(r.data.get('a')).toBe(2);
    expect(r.issues.map((i) => i.code)).toEqual(['frontmatter-duplicate-key']);
  });

  it('linia, ktora nie jest para klucz-wartosc, jest zgloszona', () => {
    const r = fm(['just words', 'a: 1']);
    expect(r.issues.map((i) => i.code)).toContain('frontmatter-line-ignored');
    expect(r.unsupported[0]?.raw).toBe('just words');
    expect(r.data.get('a')).toBe(1);
  });

  it('niezamkniete ogrodzenie: cala tresc zostaje trescia i jest ostrzezenie', () => {
    const r = parseFrontmatter('---\nname: x\n\nbody\n');
    expect(r.present).toBe(false);
    expect(r.body).toBe('body\n');
    expect(r.issues.map((i) => i.code)).toEqual(['frontmatter-unclosed']);
  });

  it('klucz __proto__ jest zwyklym kluczem', () => {
    const r = fm(['__proto__: x']);
    expect(r.data.get('__proto__')).toBe('x');
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
  });

  it('smieciowe wejscie nie rzuca', () => {
    const nasty = [
      '---\n',
      '---\n---\n',
      '---\n"unterminated: x\n---\n',
      '---\na: [1, 2\n---\n',
      '---\na: "x" trailing\n---\n',
      '---\n: nokey\n---\n',
      '---\n\t- tab\n---\n',
      '---\na: |\n---\n',
      '---\n\u0000: \u0000\n---\n',
      '---\na: [[1], 2]\n---\n',
    ];
    for (const text of nasty) expect(() => parseFrontmatter(text)).not.toThrow();
  });
});

describe('readToml', () => {
  const root = (src: string) => readToml(src, (p) => p.length === 0);

  it('czyta klucze glowne, komentarze i rozne typy', () => {
    const r = root(
      [
        '# komentarz',
        'name = "acme" # po wartosci',
        "lit = 'C:\\path'",
        'n = 1_000',
        'f = 2.5',
        'b = true',
        'hex = 0xFF',
        'when = 2026-11-03T10:00:00Z',
        'arr = [1, 2,',
        '  3, # trailing',
        ']',
        'inline = { a = 1, b = "x" }',
        'dotted.key = 1',
      ].join('\n'),
    );
    const v = r.tables[0]?.values;
    expect(r.issues).toEqual([]);
    expect(v?.get('name')).toBe('acme');
    expect(v?.get('lit')).toBe('C:\\path');
    expect(v?.get('n')).toBe(1000);
    expect(v?.get('f')).toBe(2.5);
    expect(v?.get('b')).toBe(true);
    expect(v?.get('hex')).toBe(255);
    expect(v?.get('when')).toBe('2026-11-03T10:00:00Z');
    expect(v?.get('arr')).toEqual([1, 2, 3]);
    expect(tomlToJson(v?.get('inline') ?? '')).toEqual({ a: 1, b: 'x' });
    expect(v?.get('dotted.key')).toBe(1);
  });

  it('napisy wielolinijkowe: pierwszy newline znika, naglowek w srodku nie jest tabela', () => {
    const r = readToml(
      [
        '[a]',
        'x = """',
        'line1',
        '[b]',
        'line2 \\',
        '   joined',
        '"""',
        "y = '''",
        'raw \\n',
        "'''",
      ].join('\n'),
      () => true,
    );
    const a = r.tables.find((t) => t.path.join('.') === 'a');
    expect(r.tables.map((t) => t.path.join('.'))).toEqual(['', 'a']);
    expect(a?.values.get('x')).toBe('line1\n[b]\nline2 joined\n');
    expect(a?.values.get('y')).toBe('raw \\n\n');
  });

  it('zatrzymuje wartosci tylko z zadanych tabel', () => {
    const r = readToml(
      ['[mcp.env]', 'TOKEN = "acme-fake-token-0000"', '[agents.a]', 'description = "d"'].join('\n'),
      (p) => p[0] === 'agents',
    );
    expect(r.tables.map((t) => t.path.join('.'))).toEqual(['agents.a']);
    expect(JSON.stringify(r.tables.map((t) => [...t.values]))).not.toContain('acme-fake-token');
  });

  it('klucze tabel w cudzyslowach i tablice tabel', () => {
    const r = readToml(
      ['[projects."/tmp/acme x"]', 'trust_level = "t"', '[[arr]]', 'a = 1'].join('\n'),
      () => true,
    );
    expect(r.tables.map((t) => t.path)).toEqual([[], ['projects', '/tmp/acme x'], ['arr']]);
    expect(r.tables[2]?.arrayOfTables).toBe(true);
  });

  it('blad skladni jest zgloszony z linia, a reszta pliku jest czytana', () => {
    const r = root('a = 1\nb = @@\nc = 3\n');
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]?.line).toBe(2);
    expect(r.tables[0]?.values.get('a')).toBe(1);
    expect(r.tables[0]?.values.get('c')).toBe(3);
  });

  it('smieciowe wejscie nie rzuca ani nie zawiesza', () => {
    const nasty = [
      '[',
      '[[a',
      'a =',
      'a = """',
      'a = [[[[',
      '= 1',
      'a = { b',
      '"',
      "'''",
      'a = \\u',
      '\u0000',
    ];
    for (const text of nasty) expect(() => root(text)).not.toThrow();
    expect(() => root('a = ' + '['.repeat(500))).not.toThrow();
  });

  it('klucz __proto__ w tabeli inline jest polem, nie prototypem', () => {
    const r = root('a = { __proto__ = 1 }');
    const json = tomlToJson(r.tables[0]?.values.get('a') ?? '') as Record<string, unknown>;
    expect(Object.keys(json)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(json)).toBe(Object.prototype);
  });

  it('CRLF daje to samo co LF', () => {
    const lf = root('a = "x"\nb = """\nm\n"""\n');
    const crlf = root('a = "x"\r\nb = """\r\nm\r\n"""\r\n');
    expect([...(crlf.tables[0]?.values ?? [])]).toEqual([...(lf.tables[0]?.values ?? [])]);
  });
});

describe('deriveSlug', () => {
  it('poprawna nazwa przechodzi bez zmian, takze z wielkimi literami', () => {
    expect(deriveSlug('acme-plain')).toEqual({ slug: 'acme-plain', changed: false });
    expect(deriveSlug('Acme_v1.2')).toEqual({ slug: 'Acme_v1.2', changed: false });
  });

  it('zamienia spacje, polskie litery i znaki specjalne', () => {
    expect(deriveSlug('Zażółć gęślą jaźń')).toEqual({ slug: 'Zazolc-gesla-jazn', changed: true });
    expect(deriveSlug('my skill (v2)!')).toEqual({ slug: 'my-skill-v2', changed: true });
  });

  it('nazwa niezaczynajaca sie od litery lub cyfry i z kropka na koncu', () => {
    expect(deriveSlug('.hidden')).toEqual({ slug: 'hidden', changed: true });
    expect(deriveSlug('name.')).toEqual({ slug: 'name', changed: true });
  });

  it('ucina do 64 znakow', () => {
    const d = deriveSlug('a'.repeat(100));
    expect(d.slug).toHaveLength(64);
    expect(d.changed).toBe(true);
  });

  it('nazwa zarezerwowana przez Windows dostaje przyrostek', () => {
    expect(deriveSlug('con')).toEqual({ slug: 'con-item', changed: true });
    expect(deriveSlug('NUL.txt').changed).toBe(true);
  });

  it('nazwa bez zadnego znaku ASCII dostaje stabilny skrot', () => {
    const a = deriveSlug('日本語');
    expect(a.slug).toMatch(/^item-[0-9a-f]{8}$/);
    expect(deriveSlug('日本語').slug).toBe(a.slug);
    expect(deriveSlug('中文').slug).not.toBe(a.slug);
  });

  it('wynik zawsze przechodzi walidator biblioteki', () => {
    const inputs = [
      '',
      ' ',
      '...',
      '---',
      'ąę',
      'a b',
      'COM1',
      'x'.repeat(200),
      '\u0000',
      'a/b',
      '😀emoji',
      'con.',
    ];
    for (const input of inputs) expect(validateSlug(deriveSlug(input).slug)).toBeNull();
  });
});

describe('deriveDescription i firstHeading', () => {
  it('bierze pierwszy akapit, pomija naglowki, kod, komentarze i linie poziome', () => {
    const body = [
      '<!-- x -->',
      '# Tytul',
      '',
      '```',
      'kod',
      '```',
      '',
      '---',
      '',
      'Pierwsza linia',
      'druga linia.',
      '',
      'Drugi akapit.',
    ].join('\n');
    expect(deriveDescription(body)).toBe('Pierwsza linia druga linia.');
    expect(firstHeading(body)).toBe('Tytul');
  });

  it('pusta tresc daje pusty opis, dlugi opis jest ucinany', () => {
    expect(deriveDescription('')).toBe('');
    expect(deriveDescription('# Tylko naglowek')).toBe('');
    const long = deriveDescription('slowo '.repeat(200));
    expect(long.length).toBeLessThanOrEqual(303);
    expect(long.endsWith('...')).toBe(true);
  });

  it('tytul z naglowka bez znacznikow Markdowna', () => {
    expect(firstHeading('# **Bold** [link](http://x) `code` <b>t</b> ##')).toBe('Bold link code t');
    expect(firstHeading('# ***')).toBeNull();
  });

  it('naglowek w bloku kodu nie jest tytulem', () => {
    expect(firstHeading('```\n# nie\n```\n')).toBeNull();
  });
});
