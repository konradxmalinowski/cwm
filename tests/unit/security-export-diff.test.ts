import { describe, expect, it } from 'vitest';

import { registerExportHandlers } from '../../src/main/ipc/handlers/export';
import { IpcRegistry } from '../../src/main/ipc/registry';
import type { ExportPlanDto } from '../../src/shared/ipc/export-contract';
import type { Result } from '../../src/shared/ipc/library-contract';
import { emptyPlan, entry, exportHarness } from './export-fakes';
import { root } from './import-fakes';
import { bytes } from './library-fakes';
import { SECRETS, filler } from './security-secrets';

/** Kryterium 5 Etapu 5: asercje negatywne na ladunku IPC `export:plan`. */
const ASSIGNED = `${filler(12, 31)}5${filler(12, 32)}`;
const TOML_TOKEN = `${filler(14, 41)}8${filler(14, 42)}`;

async function planPayload(entries: ReturnType<typeof entry>[]): Promise<{
  json: string;
  dto: ExportPlanDto;
}> {
  const h = await exportHarness({
    roots: [root('r-claude', 'claude-code')],
    build: (items) =>
      emptyPlan({ entries: entries.map((e) => ({ ...e, itemIds: [items[0]!.item.id] })) }),
  });
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
  const registry = new IpcRegistry({
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
  });
  registerExportHandlers(registry, { service: () => h.service });
  const r = (await handlers.get('export:plan')?.(
    {},
    { tool: 'claude-code', itemIds: [h.itemId] },
  )) as Result<ExportPlanDto>;
  if (!r.ok) throw new Error('plan nie powiodl sie');
  return { json: JSON.stringify(r), dto: r.value };
}

describe('podglad diffu bez sekretow (kryterium 5)', () => {
  it('config.toml i settings.json: sekrety poza obszarem zarzadzanym nie wychodza w before ani after', async () => {
    const toml = (token: string): string =>
      [
        'model = "acme-model"',
        '',
        '[mcp_servers.acme.env]',
        `ACME_TOKEN = "${TOML_TOKEN}"`,
        `OPENAI_KEY = "${SECRETS.openai}"`,
        '',
        `# uasm:begin\n${token}\n# uasm:end`,
      ].join('\n');
    const settings = (extra: string): string =>
      `{\n  "env": { "GITHUB_TOKEN": "${SECRETS.github}", "PASSWORD": "${ASSIGNED}" },\n  "hooks": ${extra}\n}\n`;

    const { json, dto } = await planPayload([
      entry({
        relPath: 'config.toml',
        action: 'update',
        scope: 'managed-block',
        previous: bytes(toml('stary')),
        content: bytes(toml('nowy')),
      }),
      entry({
        relPath: 'settings.json',
        action: 'update',
        scope: 'json-keys',
        previous: bytes(settings('{}')),
        content: bytes(settings('{ "a": 1 }')),
      }),
    ]);

    for (const secret of [TOML_TOKEN, SECRETS.openai, SECRETS.github, ASSIGNED]) {
      expect(json).not.toContain(secret);
    }
    const [tomlEntry, settingsEntry] = dto.entries;
    expect(tomlEntry?.before).toContain('model = "acme-model"');
    expect(tomlEntry?.before).toContain('[ukryty sekret:');
    expect(tomlEntry?.after).toContain('nowy');
    expect(settingsEntry?.after).toContain('"hooks": { "a": 1 }');
    expect(settingsEntry?.after).toContain('[ukryty sekret:');
  });

  it('plik o nazwie auth.json i klucz prywatny traca tresc, a zmiana poza sekretem zostaje widoczna', async () => {
    const body = filler(64, 51);
    const { json, dto } = await planPayload([
      entry({
        relPath: 'auth.json',
        previous: bytes('{ "account": "jan-acme" }\n'),
        content: bytes('{ "account": "ewa-acme" }\n'),
        action: 'update',
      }),
      entry({
        relPath: 'notatka.md',
        content: bytes(`wstep\n${SECRETS.pemBegin}\n${body}\n${SECRETS.pemEnd}\nkoniec\n`),
      }),
    ]);
    expect(json).not.toContain('jan-acme');
    expect(json).not.toContain('ewa-acme');
    expect(json).not.toContain(body);
    expect(dto.entries[1]?.after).toBe(
      'wstep\n[ukryty sekret: known-key]\n[ukryty sekret: known-key]\n[ukryty sekret: known-key]\nkoniec\n',
    );
  });
});
