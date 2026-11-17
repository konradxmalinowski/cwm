import type { ItemDraft, JsonValue } from '../../core/model/item';
import { isIgnoredPath } from '../../core/model/library-file-names';
import type { SourceReader } from '../../core/ports/source-reader';
import type { ImportWarning } from '../../core/ports/tool-adapter';
import { ScanContext } from '../shared/scan-context';
import { deriveDescription, deriveSlug } from '../shared/slug';
import { TextDecodeError, toParsableText } from '../shared/text';
import { readToml, tomlString, tomlToJson, type TomlValue } from '../shared/toml';

const TOML_EXTENSION = /\.toml$/i;
const KNOWN_KEYS = new Set(['prompt', 'description']);

/**
 * Wstawka powloki `!{...}` w komendzie Gemini CLI jest wykonywana po potwierdzeniu uzytkownika
 * w samym narzedziu. Tu jest tylko sygnalem do ostrzezenia przy imporcie i eksporcie.
 */
export const SHELL_INJECTION = /!\{/;

/** Wstawka pliku `@{...}`: tresc pliku z dysku trafia do promptu, wiec to tez wymaga uwagi. */
export const FILE_INJECTION = /@\{/;

/**
 * Komendy Gemini CLI z katalogu `commands/`: plik `.toml` to jedna komenda. Podkatalogi tworza w
 * narzedziu przestrzenie nazw (`git/commit.toml` to `/git:commit`); tego jeszcze nie obslugujemy
 * i mowimy o tym wprost zamiast je pomijac po cichu (ADR 0055).
 */
export async function scanGeminiCommands(ctx: ScanContext): Promise<void> {
  let entries;
  try {
    entries = await ctx.list('');
  } catch (error) {
    ctx.skipFromError(error, '');
    return;
  }
  for (const entry of entries) {
    if (isIgnoredPath(entry.name)) continue;
    try {
      let readPath = entry.name;
      if (entry.type === 'symlink') {
        const target = await ctx.follow(entry.name);
        if (target.outside) {
          ctx.skip(
            entry.name,
            'symlink-outside',
            `"${entry.name}" wskazuje poza wybrany katalog i nie jest śledzone.`,
          );
          continue;
        }
        if (target.type !== 'file') {
          ctx.skip(
            entry.name,
            'unsupported',
            `"${entry.name}" jest dowiązaniem do czegoś, co nie jest plikiem.`,
          );
          continue;
        }
        readPath = target.relPath;
      } else if (entry.type === 'directory') {
        ctx.skip(
          entry.name,
          'unsupported',
          `Podkatalog "${entry.name}" tworzy w Gemini CLI przestrzeń nazw komend (/${entry.name}:nazwa). Przestrzenie nazw nie są jeszcze importowane.`,
        );
        continue;
      } else if (entry.type !== 'file') {
        ctx.skip(
          entry.name,
          'unsupported',
          `"${entry.name}" to plik specjalny i nie jest importowany.`,
        );
        continue;
      }
      if (!TOML_EXTENSION.test(entry.name)) {
        ctx.skip(
          entry.name,
          'not-an-element',
          `"${entry.name}" nie ma rozszerzenia .toml, więc nie jest komendą.`,
        );
        continue;
      }
      const bytes = await ctx.read(readPath);
      buildCommand(ctx, {
        display: entry.name,
        stem: entry.name.replace(TOML_EXTENSION, ''),
        bytes,
        mode: await ctx.mode(readPath),
        aliasKey: ctx.aliasKey(readPath),
      });
    } catch (error) {
      ctx.skipFromError(error, entry.name);
    }
  }
}

interface CommandInput {
  readonly display: string;
  readonly stem: string;
  readonly bytes: Uint8Array;
  readonly mode: number | null;
  readonly aliasKey: string;
}

function textOrNull(value: TomlValue | undefined): string | null {
  const s = tomlString(value);
  return s === null || s.trim() === '' ? null : s.trim();
}

function buildCommand(ctx: ScanContext, input: CommandInput): void {
  let text: string;
  try {
    text = toParsableText(input.bytes);
  } catch (error) {
    if (!(error instanceof TextDecodeError)) throw error;
    ctx.skip(
      input.display,
      'malformed',
      `Plik "${input.display}" nie jest poprawnym tekstem UTF-8.`,
    );
    return;
  }
  const parsed = readToml(text, (path, array) => path.length === 0 && !array);
  const values = parsed.tables[0]?.values ?? new Map<string, TomlValue>();
  if (parsed.issues.length > 0) {
    const first = parsed.issues[0];
    ctx.skip(
      input.display,
      'malformed',
      `Plik "${input.display}" nie jest poprawnym TOML-em (linia ${first?.line ?? 1}: ${first?.message ?? 'błąd składni'}).`,
    );
    return;
  }
  const prompt = tomlString(values.get('prompt'));
  if (prompt === null) {
    ctx.skip(
      input.display,
      'malformed',
      `Plik "${input.display}" nie ma pola prompt (tekst), które Gemini CLI wymaga.`,
    );
    return;
  }

  const warnings: ImportWarning[] = [];
  const unmapped: { path: string; value: JsonValue }[] = [];
  const sourceDescription = textOrNull(values.get('description'));
  const description = sourceDescription ?? deriveDescription(prompt);
  if (sourceDescription === null) {
    warnings.push({
      code: 'description-derived',
      message: 'Komenda nie ma opisu. Opis wyliczono z pierwszego akapitu promptu.',
    });
  }
  const rawDescription = values.get('description');
  if (rawDescription !== undefined && typeof rawDescription !== 'string') {
    unmapped.push({ path: 'toml.description', value: tomlToJson(rawDescription) });
    warnings.push({
      code: 'toml-field-not-text',
      message: 'Pole "description" komendy nie jest tekstem, więc nie zostało użyte.',
    });
  }
  for (const [key, value] of values) {
    if (!KNOWN_KEYS.has(key)) unmapped.push({ path: `toml.${key}`, value: tomlToJson(value) });
  }
  if (SHELL_INJECTION.test(prompt)) {
    warnings.push({
      code: 'command-runs-shell',
      message:
        'Prompt zawiera wstawkę powłoki !{...}. Gemini CLI wykona to polecenie po potwierdzeniu w narzędziu, więc potraktuj tę komendę jak kod do uruchomienia.',
    });
  }

  if (FILE_INJECTION.test(prompt)) {
    warnings.push({
      code: 'command-reads-files',
      message:
        'Prompt zawiera wstawkę pliku @{...}. Gemini CLI wczyta wskazany plik lub katalog i wyśle jego treść do modelu, więc sprawdź, co komenda czyta.',
    });
  }

  const slug = deriveSlug(input.stem);
  if (slug.changed) {
    warnings.push({
      code: 'slug-derived',
      message: `Nazwa "${input.stem}" nie nadaje się na bezpieczną nazwę elementu. Użyto "${slug.slug}"; oryginał zostaje jako alias.`,
    });
  }
  ctx.add({
    relPath: input.display,
    kind: 'command',
    draft: {
      kind: 'command',
      identity: { slug: slug.slug, declaredName: null, aliases: slug.changed ? [input.stem] : [] },
      content: {
        title: slug.slug,
        description,
        descriptionOrigin: sourceDescription === null ? 'derived' : 'source',
        body: prompt,
      },
      assets: [],
      source: {
        snapshots: [
          {
            tool: ctx.tool,
            files: [{ relPath: input.display, bytes: input.bytes, mode: input.mode }],
            unmappedKeys: unmapped,
          },
        ],
        importedFrom: null,
      },
    },
    warnings,
    aliasKey: input.aliasKey,
  });
}

/** Czytnik, ktory nigdy nie jest wolany: `buildCommand` dostaje bajty, nie czyta zrodla. */
const NO_READER: SourceReader = {
  list: () => Promise.reject(new Error('Czytnik nie jest uzywany przy parsowaniu bajtow.')),
  read: () => Promise.reject(new Error('Czytnik nie jest uzywany przy parsowaniu bajtow.')),
  resolveSymlink: () =>
    Promise.reject(new Error('Czytnik nie jest uzywany przy parsowaniu bajtow.')),
  mode: () => Promise.resolve(null),
};

/** Szkic komendy z samych bajtow pliku `.toml` (eksport porownuje nim snapshot z elementem). */
export function parseCommandDraft(bytes: Uint8Array, stem: string): ItemDraft | null {
  const ctx = new ScanContext(
    'gemini-cli',
    {
      rootId: 'parse',
      tool: 'gemini-cli',
      kind: 'commands',
      label: 'commands',
      exists: true,
      active: true,
    },
    NO_READER,
  );
  buildCommand(ctx, { display: `${stem}.toml`, stem, bytes, mode: null, aliasKey: '' });
  return ctx.candidates[0]?.draft ?? null;
}
