/**
 * Przepisanie odwolan do natywnego katalogu konfiguracji w kopiach zasobow trafiajacych do profilu.
 * Sesja z `CLAUDE_CONFIG_DIR` czyta pliki z profilu, ale tresc skilla czy agenta z `~/.claude/...`
 * kierowalaby model do prawdziwego katalogu natywnego. Funkcja jest czysta; nie dotyka polecen hookow.
 */
export interface RewriteResult {
  readonly text: string;
  readonly count: number;
}

const HOME_FORMS = ['~/.claude', '$HOME/.claude', '${HOME}/.claude'];

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Formy zapisu natywnego katalogu: `~/.claude`, `$HOME/.claude`, `${HOME}/.claude` oraz podane
 * sciezki bezwzgledne (katalog domowy, `realpath` zrodla importu). Dopasowanie konczy sie na granicy
 * nazwy, wiec `.claude.json` i `.claude-backup` zostaja bez zmian.
 */
export function nativeDirPattern(absoluteDirs: readonly string[]): RegExp {
  const forms = [
    ...new Set([...HOME_FORMS, ...absoluteDirs.map((dir) => dir.replace(/\/+$/, ''))]),
  ].filter((form) => form !== '');
  forms.sort((a, b) => b.length - a.length);
  const alternatives = forms.map(escapeRegExp).join('|');
  return new RegExp(`(?<![\\w./~$}-])(?:${alternatives})(?![\\w-]|\\.\\w)`, 'g');
}

export function rewriteNativeConfigRefs(
  text: string,
  pattern: RegExp,
  profileDir: string,
): RewriteResult {
  let count = 0;
  const rewritten = text.replace(pattern, () => {
    count += 1;
    return profileDir;
  });
  return { text: rewritten, count };
}
