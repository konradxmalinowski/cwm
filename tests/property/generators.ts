import fc from 'fast-check';

import { deriveDescription, firstHeading } from '../../src/adapters/shared/slug';
import type {
  AssetInput,
  HookDefinition,
  ItemAttributes,
  ItemDraft,
  ReasoningDepth,
} from '../../src/core/model/item';

/**
 * Generatory w zakresie, ktory adaptery obsluguja (ROADMAP Etap 9 kryterium 7): slug ASCII,
 * frontmatter, tresc z CRLF, polskie znaki i CJK. Kazdy szkic jest w postaci kanonicznej, czyli
 * takiej, jaka da import: tytul i opis wyliczony licza sie tak samo jak w markdown-item.ts.
 */

const ASCII = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const POLISH = 'ąćęłńóśźżĄĆĘŁŃÓŚŹŻ';
const CJK = '日本語テスト中文字한';
const PUNCT = ' .,:;!?"\'#-*()[]{}/\\`~@%&+=<>|$';

const charOf = (alphabet: string) => fc.constantFrom(...alphabet);
const anyChar = fc.oneof(
  { weight: 6, arbitrary: charOf(ASCII) },
  { weight: 2, arbitrary: charOf(POLISH) },
  { weight: 1, arbitrary: charOf(CJK) },
  { weight: 3, arbitrary: charOf(PUNCT) },
);

/** Jedna linia tekstu, bez znakow konca linii i bez znakow sterujacych. */
export const lineText = (maxLength = 40) => fc.string({ unit: anyChar, maxLength });

export const slugArb = fc
  .tuple(charOf(ASCII), fc.string({ unit: charOf(`${ASCII}-_.`), maxLength: 18 }), charOf(ASCII))
  .map(([a, mid, z]) => `acme-${a}${mid}${z}`.replace(/\.\.+/g, '.'));

const bodyLine = fc.oneof(
  lineText(),
  lineText(30).map((t) => `# ${t}`),
  lineText(30).map((t) => `## ${t}`),
  lineText(30).map((t) => `- ${t}`),
  lineText(20).map((t) => `key: ${t}`),
  fc.constantFrom('', '', '---', '```', '```ts', '<!-- acme -->', '    kod', '\t# tab'),
);

/**
 * Tresc w postaci, w jakiej przychodzi do biblioteki: dowolne konce linii, w tym CRLF i mieszane.
 * Biblioteka normalizuje je do LF (ADR 0016), wiec `x` w petli to element po zapisie.
 */
export const rawBodyArb = fc
  .tuple(
    fc.array(bodyLine, { minLength: 0, maxLength: 12 }),
    fc.boolean(),
    fc.constantFrom('\n', '\r\n', 'mixed'),
  )
  .map(([lines, trailing, eol]) => {
    const joined = lines.reduce(
      (acc, line, i) =>
        i === 0 ? line : acc + (eol === 'mixed' ? (i % 2 === 0 ? '\r\n' : '\n') : eol) + line,
      '',
    );
    const end = eol === 'mixed' ? '\r\n' : eol;
    return trailing && lines.length > 0 ? joined + end : joined;
  });

export const lf = (text: string): string => text.replace(/\r\n?/g, '\n');

/**
 * Granica dziedziny, nie poziom zgodnosci: import czyta `name` i `description` jak YAML, czyli
 * przycina biale znaki z brzegow, a pusty napis uznaje za brak pola (asText w frontmatter.ts).
 * Opis ze zrodla w postaci kanonicznej jest wiec niepusty i przyciety.
 */
const trimmedText = (maxLength: number) =>
  lineText(maxLength)
    .map((t) => t.trim())
    .filter((t) => t !== '');

const descriptionArb = trimmedText(60);

interface Described {
  readonly description: string;
  readonly descriptionOrigin: 'source' | 'derived';
}

/** Opis zrodlowy albo wyliczony z tresci tak samo, jak zrobi to import. */
const withDescription = (body: string, source: string | null): Described =>
  source === null
    ? { description: deriveDescription(lf(body)), descriptionOrigin: 'derived' }
    : { description: source, descriptionOrigin: 'source' };

const titleOf = (declaredName: string | null, body: string, sourceName: string): string =>
  declaredName ?? firstHeading(lf(body)) ?? sourceName;

const classification = { scope: 'private' as const, secretFindings: [] };

const SEGMENT_CHARS = `${'abcdefghijklmnopqrstuvwxyz0123456789'}${POLISH}${CJK} -_`;
const segmentArb = fc
  .tuple(
    charOf('abcdefghijklmnopqrstuvwxyz0123456789'),
    fc.string({ unit: charOf(SEGMENT_CHARS), maxLength: 10 }),
    charOf('abcdefghijklmnopqrstuvwxyz'),
  )
  .map(([a, mid, z]) => `${a}${mid}${z}`);

const assetPathArb = fc
  .tuple(fc.array(segmentArb, { minLength: 0, maxLength: 3 }), segmentArb, fc.boolean())
  .map(([dirs, name, ext]) => [...dirs, ext ? `${name}.md` : name].join('/'));

/** Pliki pomocnicze: rozne sciezki bez wzgledu na wielkosc liter, dowolne bajty (tez binarne). */
export const assetsArb: fc.Arbitrary<AssetInput[]> = fc
  .uniqueArray(fc.tuple(assetPathArb, fc.uint8Array({ maxLength: 64 })), {
    maxLength: 4,
    selector: ([path]) => path.toLowerCase(),
  })
  .filter((list) => {
    // Plik i katalog pod ta sama sciezka sa niedozwolone (ADR 0031): generator ich nie tworzy.
    const paths = list.map(([p]) => p.toLowerCase());
    return paths.every((p) => !paths.some((q) => q.startsWith(`${p}/`)));
  })
  .map((list) => list.map(([relPath, bytes]) => ({ relPath, bytes })));

const nameArb = fc.oneof(
  { weight: 2, arbitrary: fc.constant(null) },
  { weight: 2, arbitrary: fc.constant('same') },
  { weight: 1, arbitrary: trimmedText(30) },
);

export interface Shape {
  readonly assets?: boolean;
  readonly kind: 'skill' | 'command' | 'agent';
}

/** Skill, komenda albo agent oparty na Markdownie z frontmatterem. */
export function markdownItemArb(shape: Shape): fc.Arbitrary<ItemDraft> {
  return fc
    .record({
      slug: slugArb,
      name: nameArb,
      description: fc.option(descriptionArb, { nil: null }),
      body: rawBodyArb,
      assets: shape.assets === true ? assetsArb : fc.constant([] as AssetInput[]),
      attributes: shape.kind === 'agent' ? agentAttributesArb : fc.constant({}),
    })
    .map(({ slug, name, description, body, assets, attributes }) => {
      const declaredName = name === 'same' ? slug : name;
      return {
        kind: shape.kind,
        identity: { slug, declaredName, aliases: [] },
        content: {
          title: titleOf(declaredName, body, slug),
          ...withDescription(body, description),
          body,
        },
        attributes,
        assets,
        classification,
      } satisfies ItemDraft;
    });
}

const depthArb: fc.Arbitrary<ReasoningDepth> = fc.constantFrom('routine', 'deep', 'deepest');

export const agentAttributesArb: fc.Arbitrary<ItemAttributes> = fc
  .record(
    {
      reasoningDepth: depthArb,
      accentColor: fc.constantFrom('blue', 'red', 'purple', 'cyan'),
      memoryScope: fc.constantFrom('user', 'project', 'local'),
    },
    { requiredKeys: [] },
  )
  .map(({ reasoningDepth, accentColor, memoryScope }) => ({
    ...(reasoningDepth !== undefined ? { reasoningDepth } : {}),
    ...(accentColor !== undefined ? { presentation: { accentColor } } : {}),
    ...(memoryScope !== undefined ? { memoryScope } : {}),
  }));

export const CLAUDE_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
] as const;

const commandArb = fc.oneof(
  slugArb.map((s) => ({ command: `/opt/acme/${s}.sh`, pathStyle: 'absolute' as const })),
  slugArb.map((s) => ({
    command: `$HOME/.acme/${s}.sh --flag`,
    pathStyle: 'home-relative' as const,
  })),
  slugArb.map((s) => ({
    command: `~/acme/${s} "arg z spacja"`,
    pathStyle: 'home-relative' as const,
  })),
);

/** Jeden hook w swiezym pliku: slug i tytul powstaja ze zdarzenia i pozycji (hooks.ts). */
export function hookArb(events: readonly string[]): fc.Arbitrary<ItemDraft> {
  return fc
    .record({
      event: fc.constantFrom(...events),
      matcher: fc.option(fc.constantFrom('Bash', 'Edit|Write', 'mcp__acme__.*'), { nil: null }),
      command: commandArb,
      timeoutSeconds: fc.option(fc.integer({ min: 1, max: 600 }), { nil: null }),
    })
    .map(({ event, matcher, command, timeoutSeconds }) => {
      const hook: HookDefinition = { event, matcher, ...command, timeoutSeconds };
      return {
        kind: 'hook',
        identity: { slug: `${event}-1`, declaredName: null, aliases: [] },
        content: {
          title: matcher === null ? event : `${event} (${matcher})`,
          description: '',
          descriptionOrigin: 'derived',
          body: '',
        },
        attributes: { hook },
        classification,
      } satisfies ItemDraft;
    });
}

export const instructionArb: fc.Arbitrary<ItemDraft> = rawBodyArb
  .filter((body) => lf(body).trim() !== '')
  .map((body) => ({
    kind: 'global-instruction',
    identity: { slug: 'instructions', declaredName: null, aliases: [] },
    content: {
      title: 'Instrukcje',
      description: deriveDescription(lf(body)),
      descriptionOrigin: 'derived',
      body,
    },
    classification,
  }));
