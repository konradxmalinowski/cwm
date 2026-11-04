import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';

import { SegmentTomlEditor, tomlString } from '../../src/adapters/shared/toml/segment-editor';

const editor = new SegmentTomlEditor();
const reg = (name: string, description = 'Opis', configFile = `agents/${name}.toml`) => ({
  name,
  description,
  keepDescription: false,
  configFile,
});

const REAL = `# Synthetic Codex configuration

model = "acme"
acme.dotted = 1

[features]
acme_flag = true

# Zarejestrowany agent
[agents.acme-reviewer]
description = "Reviews"
config_file = "agents/acme-reviewer.toml"

[mcp_servers.acme]
command = "acme"
args = [
  "a",
  "b",
]

[[acme_tables]]
note = """multi
[agents.not-a-table]
description = "wewnatrz napisu"
"""

[notice]
dotted.key = 1
`;

function ok(result: ReturnType<SegmentTomlEditor['edit']>): string {
  if (!result.ok) throw new Error(result.message);
  return result.text;
}

describe('SegmentTomlEditor', () => {
  it('dopisuje trzyliniowy blok na koncu, a reszta pliku jest bajt w bajt', () => {
    const out = ok(editor.edit(REAL, [reg('acme-new')]));
    expect(out.startsWith(REAL)).toBe(true);
    expect(out.slice(REAL.length)).toBe(
      '\n[agents.acme-new]\ndescription = "Opis"\nconfig_file = "agents/acme-new.toml"\n',
    );
    const tree = parse(out) as { agents: Record<string, unknown> };
    expect(Object.keys(tree.agents).sort()).toEqual(['acme-new', 'acme-reviewer']);
  });

  it('istniejacy, zgodny blok nie zmienia pliku (changed false)', () => {
    const r = editor.edit(REAL, [reg('acme-reviewer', 'Reviews')]);
    expect(r).toEqual({ ok: true, text: REAL, changed: false });
  });

  it('zmienia tylko linie description w istniejacym bloku, komentarze zostaja', () => {
    const out = ok(editor.edit(REAL, [reg('acme-reviewer', 'Nowy "opis"')]));
    expect(out).toBe(REAL.replace('description = "Reviews"', 'description = "Nowy \\"opis\\""'));
  });

  it('keepDescription zostawia opis wpisu, gdy plik juz go ma', () => {
    const r = editor.edit(REAL, [{ ...reg('acme-reviewer', 'Inny'), keepDescription: true }]);
    expect(r).toEqual({ ok: true, text: REAL, changed: false });
  });

  it('config_file zapisany inaczej, ale rownowazny, nie jest przepisywany', () => {
    const text = REAL.replace('"agents/acme-reviewer.toml"', '"./agents/acme-reviewer.toml"');
    const r = editor.edit(text, [reg('acme-reviewer', 'Reviews')], {
      sameConfigFile: (a, b) => a.replace(/^\.\//, '') === b,
    });
    expect(r).toEqual({ ok: true, text, changed: false });
  });

  it('brakujacy klucz w istniejacym bloku jest dopisywany po ostatnim kluczu', () => {
    const text = '[agents.a]\ndescription = "x"\n\n[other]\nk = 1\n';
    const out = ok(editor.edit(text, [reg('a', 'x')]));
    expect(out).toBe(
      '[agents.a]\ndescription = "x"\nconfig_file = "agents/a.toml"\n\n[other]\nk = 1\n',
    );
  });

  it('nazwa z kropka dostaje cudzyslow w naglowku', () => {
    const out = ok(editor.edit('x = 1\n', [reg('a.b')]));
    expect(out).toContain('[agents."a.b"]');
    expect((parse(out) as { agents: Record<string, unknown> }).agents['a.b']).toBeDefined();
  });

  it('zachowuje CRLF, BOM i brak koncowej nowej linii', () => {
    const text = '﻿x = 1\r\n[y]\r\nz = 2';
    const out = ok(editor.edit(text, [reg('n')]));
    expect(out.startsWith(text)).toBe(true);
    expect(out.startsWith('﻿')).toBe(true);
    expect(out).toContain('\r\n[agents.n]\r\ndescription = "Opis"\r\n');
    expect(out).not.toMatch(/[^\r]\n/);
  });

  it('pusty plik dostaje sam blok', () => {
    expect(ok(editor.edit('', [reg('n')]))).toBe(
      '[agents.n]\ndescription = "Opis"\nconfig_file = "agents/n.toml"\n',
    );
  });

  it('opis z cudzyslowami, backslashem, nowa linia i DEL jest poprawnym TOML-em', () => {
    const tricky = 'a "b" \\ c\nd\t\u007f e';
    const out = ok(editor.edit('', [reg('n', tricky)]));
    expect((parse(out) as { agents: { n: { description: string } } }).agents.n.description).toBe(
      tricky,
    );
    expect(tomlString('x')).toBe('"x"');
  });

  describe('preflight', () => {
    it('plik realny z komentarzami, sekcjami obcymi i pustymi liniami przechodzi', () => {
      expect(editor.preflight(REAL, ['acme-reviewer', 'acme-new']).ok).toBe(true);
    });

    it('naglowek wewnatrz wielolinijkowego napisu i tablicy nie jest tabela', () => {
      const out = ok(editor.edit(REAL, [reg('not-a-table')]));
      expect((parse(out) as { agents: Record<string, unknown> }).agents['not-a-table']).toEqual({
        description: 'Opis',
        config_file: 'agents/not-a-table.toml',
      });
    });

    const refusals: [string, string, RegExp][] = [
      ['klucz z kropka poza tabela (preambula)', 'agents.x.description = "a"\n', /klucz z kropką/],
      [
        'klucz agents w korzeniu jako tabela inline',
        'agents = { x = { description = "a" } }\n',
        /klucz z kropką|agents/,
      ],
      ['klucz z kropka w tabeli agents', '[agents]\nx.description = "a"\n', /klucz z kropką/],
      ['tablica tabel [[agents]]', '[[agents]]\nname = "x"\n', /tablica tabel/],
      ['tablica tabel [[agents.x]]', '[[agents.x]]\nname = "x"\n', /tablica tabel/],
      [
        'komentarz oddzielony pusta linia w zarzadzanym bloku',
        '[agents.n]\ndescription = "a"\n\n# osierocony\nconfig_file = "x"\n',
        /komentarz oddzielony/,
      ],
      ['niepoprawny TOML', '[agents\n', /TOML/],
    ];
    for (const [name, text, message] of refusals) {
      it(`odmawia: ${name}`, () => {
        const r = editor.edit(text, [reg('n')]);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.message).toMatch(message);
      });
    }

    it('wpis agents.<nazwa> w postaci inline nie dostaje drugiego bloku', () => {
      const r = editor.edit('[agents]\nn = { description = "a", config_file = "b" }\n', [reg('n')]);
      expect(r.ok).toBe(false);
    });

    it('wartosc wielolinijkowa klucza w zarzadzanym bloku nie jest przepisywana', () => {
      const text = '[agents.n]\ndescription = """\nx\n"""\nconfig_file = "old"\n';
      const r = editor.edit(text, [reg('n', 'inny')]);
      expect(r.ok).toBe(false);
    });

    it('komentarz oddzielony pusta linia poza zarzadzanym blokiem nie blokuje', () => {
      const text =
        '[other]\nk = 1\n\n# luzny komentarz\n\n[agents.n]\ndescription = "Opis"\nconfig_file = "agents/n.toml"\n';
      expect(editor.preflight(text, ['n']).ok).toBe(true);
    });
  });
});
