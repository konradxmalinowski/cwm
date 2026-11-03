import type { JsonValue } from '../../core/model/item';
import type { ImportWarning } from '../../core/ports/tool-adapter';
import { deriveSlug } from './slug';
import type { ScanContext } from './scan-context';
import { encodeUtf8 } from './text';

type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const HOME_RELATIVE = /(^|[\s"'=:])(~\/|\$HOME\b|\$\{HOME\})/;

export interface HookSourceOptions {
  /** Plik zrodlowy dla komunikatow i `relPath`, np. "settings.json". */
  readonly file: string;
  /** Ostrzezenia dla kazdego hooka z pliku (np. plik niewazny w Codeksie). */
  readonly warnings: readonly ImportWarning[];
  /** Nieznane klucze korzenia pliku, dopisywane do kazdego hooka. */
  readonly rootUnmapped: readonly { readonly path: string; readonly value: JsonValue }[];
}

/**
 * Jeden wpis `command` to jeden element. Snapshot hooka jest wycinkiem JSON, a nie calym
 * plikiem: `settings.json` Claude'a trzyma tez zmienne srodowiskowe i uprawnienia, ktorych
 * nie ma powodu kopiowac do biblioteki.
 */
export function addHookCandidates(
  ctx: ScanContext,
  hooks: unknown,
  options: HookSourceOptions,
): void {
  if (!isRecord(hooks)) {
    ctx.skip(options.file, 'malformed', `Klucz "hooks" w "${options.file}" nie jest obiektem.`);
    return;
  }
  for (const [event, groups] of Object.entries(hooks)) {
    const eventPath = `${options.file}#hooks/${event}`;
    if (!Array.isArray(groups)) {
      ctx.skip(eventPath, 'malformed', `Zdarzenie "${event}" w "${options.file}" nie jest listą.`);
      continue;
    }
    let ordinal = 0;
    groups.forEach((group: unknown, gi) => {
      if (!isRecord(group)) {
        ctx.skip(
          `${eventPath}/${gi}`,
          'malformed',
          `Wpis ${gi} zdarzenia "${event}" nie jest obiektem.`,
        );
        return;
      }
      // Wpis bez listy "hooks" jest samym hookiem, a "matcher" jest wtedy jego wlasnym polem.
      const direct = !Array.isArray(group['hooks']);
      const inner = direct ? [group] : (group['hooks'] as unknown[]);
      const matcher = typeof group['matcher'] === 'string' ? group['matcher'] : null;
      inner.forEach((hook: unknown, hi) => {
        const shown = `${eventPath}/${gi}/${hi}`;
        if (!isRecord(hook) || hook['type'] !== 'command' || typeof hook['command'] !== 'string') {
          ctx.skip(
            shown,
            'unsupported',
            `Hook ${hi} zdarzenia "${event}" nie jest poleceniem (type "command"), więc nie jest importowany.`,
          );
          return;
        }
        ordinal++;
        const unmapped: { path: string; value: JsonValue }[] = [...options.rootUnmapped];
        if (!direct) {
          for (const [k, v] of Object.entries(group)) {
            if (k !== 'matcher' && k !== 'hooks')
              unmapped.push({ path: `group.${k}`, value: v as JsonValue });
          }
        }
        for (const [k, v] of Object.entries(hook)) {
          const known =
            k === 'type' || k === 'command' || k === 'timeout' || (direct && k === 'matcher');
          if (!known) unmapped.push({ path: `hook.${k}`, value: v as JsonValue });
        }
        const command = hook['command'];
        const timeout = typeof hook['timeout'] === 'number' ? hook['timeout'] : null;
        const slug = deriveSlug(`${event}-${ordinal}`);
        const warnings: ImportWarning[] = [...options.warnings];
        if (slug.changed) {
          warnings.push({
            code: 'slug-derived',
            message: `Nazwa zdarzenia "${event}" nie nadaje się na bezpieczną nazwę elementu. Użyto "${slug.slug}".`,
          });
        }
        const snapshot = JSON.stringify({ event, matcher, hook }, null, 2) + '\n';
        ctx.add({
          relPath: shown,
          kind: 'hook',
          draft: {
            kind: 'hook',
            identity: {
              slug: slug.slug,
              declaredName: null,
              aliases: slug.changed ? [`${event}-${ordinal}`] : [],
            },
            content: {
              title: matcher === null ? event : `${event} (${matcher})`,
              description: '',
              descriptionOrigin: 'derived',
              // Polecenie siedzi w `attributes.hook`; druga kopia w treści rozjechałaby się przy edycji.
              body: '',
            },
            attributes: {
              hook: {
                event,
                matcher,
                command,
                pathStyle: HOME_RELATIVE.test(command) ? 'home-relative' : 'absolute',
                timeoutSeconds: timeout,
              },
            },
            assets: [],
            source: {
              snapshots: [
                {
                  tool: ctx.tool,
                  files: [{ relPath: 'hook.json', bytes: encodeUtf8(snapshot), mode: null }],
                  unmappedKeys: unmapped,
                },
              ],
              importedFrom: null,
            },
          },
          warnings,
          aliasKey: null,
        });
      });
    });
  }
}
