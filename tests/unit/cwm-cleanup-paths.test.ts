import { describe, expect, it } from 'vitest';

import { validateCleanupPath } from '../../src/core/cwm';

const HASH = '0123456789abcdef';
const RLO = String.fromCharCode(0x202e);
const COMBINING_ACUTE = String.fromCharCode(0x301);

describe('validateCleanupPath (PRF-02)', () => {
  it.each([
    ['claude/settings.json', 'profile'],
    ['claude/CLAUDE.md', 'profile'],
    ['claude/skills/acme-lint/SKILL.md', 'profile'],
    ['claude/skills/acme-lint/scripts/run.sh', 'profile'],
    ['claude/agents/acme-reviewer.md', 'profile'],
    ['claude/commands/acme-ship.md', 'profile'],
    [`sessions/${HASH}/settings.json`, 'session'],
    [`sessions/${HASH}/mcp.json`, 'session'],
    [`sessions/${HASH}/plugin/.claude-plugin/plugin.json`, 'session'],
    [`sessions/${HASH}/plugin/skills/acme-core/SKILL.md`, 'session'],
    [`plugins/acme-a-tools@${HASH}/.claude-plugin/plugin.json`, 'plugin'],
  ])('przyjmuje %s', (path, area) => {
    expect(validateCleanupPath(path)).toEqual({ ok: true, area });
  });

  it.each([
    ['', 'pusta'],
    ['/etc/passwd', 'bezwzgledna'],
    ['claude/../.claude.json', 'segment ..'],
    ['claude/skills/../../x', 'segment ..'],
    ['claude/./settings.json', 'segment .'],
    ['claude//settings.json', 'pusty segment'],
    ['claude\\settings.json', 'backslash'],
    ['claude/settings.json\n', 'znak sterujacy'],
    [`claude/skills/a${RLO}b/SKILL.md`, 'znak formatujacy (RLO)'],
    [`claude/skills/e${COMBINING_ACUTE}/SKILL.md`, 'nie-NFC'],
    ['claude', 'sam katalog profilu'],
    ['claude/skills', 'katalog skills'],
    ['claude/skills/acme-lint', 'katalog skilla bez pliku'],
    ['claude/agents/acme-reviewer.txt', 'agent bez .md'],
    ['claude/agents/Upper.md', 'wielkie litery'],
    ['claude/commands/sub/dir.md', 'zbyt gleboko dla komendy'],
    ['claude/unknown.json', 'poza lista'],
    ['other/settings.json', 'inny korzen'],
    [`sessions/${HASH}/other.json`, 'poza lista w sesji'],
    ['sessions/xyz/settings.json', 'zly skrot projektu'],
    [`plugins/no-hash/file`, 'migawka bez skrotu'],
    [`plugins/acme@${HASH}`, 'migawka bez pliku'],
  ])('odrzuca %j (%s)', (path) => {
    expect(validateCleanupPath(path).ok).toBe(false);
  });

  it.each([
    '.claude.json',
    '.credentials.json',
    'backups/x',
    'projects/x/y.jsonl',
    'plugins/synced/x',
    'history.jsonl',
    'file-history/x',
    'todos/x.json',
    'shell-snapshots/x',
    'plans/x.md',
    'ide/x',
    'statsig/x',
    'skills/synced/SKILL.md',
  ])('nie dotyka danych silnika: claude/%s', (name) => {
    const result = validateCleanupPath(`claude/${name}`);
    expect(result.ok).toBe(false);
  });

  it('odrzuca chronione nazwy w drzewach profilu i sesji, dopuszcza je w migawce pluginu i CLAUDE.md w korzeniu profilu', () => {
    expect(validateCleanupPath('claude/skills/acme-lint/CLAUDE.md').ok).toBe(false);
    expect(validateCleanupPath('claude/skills/acme-lint/.claude/x').ok).toBe(false);
    expect(validateCleanupPath(`plugins/acme@${HASH}/.mcp.json`).ok).toBe(true);
    expect(validateCleanupPath(`sessions/${HASH}/plugin/skills/x/CLAUDE.md`).ok).toBe(false);
    expect(validateCleanupPath(`plugins/acme@${HASH}/../x`).ok).toBe(false);
    expect(validateCleanupPath('claude/CLAUDE.md').ok).toBe(true);
  });

  it('odrzuca nazwy silnika bez wzgledu na wielkosc liter i dlugie lub nie-tekstowe wejscie', () => {
    expect(validateCleanupPath('claude/Projects/x').ok).toBe(false);
    expect(validateCleanupPath(`claude/skills/${'a'.repeat(80)}/SKILL.md`).ok).toBe(false);
    expect(validateCleanupPath(`claude/skills/x/${'d/'.repeat(300)}f`).ok).toBe(false);
    expect(validateCleanupPath(undefined).ok).toBe(false);
    expect(validateCleanupPath(42).ok).toBe(false);
  });
});
