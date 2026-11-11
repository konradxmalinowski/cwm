import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';

import { firstHeading } from '../../src/adapters/shared/slug';
import { BLOCK_END, BLOCK_START, blockBody } from '../../src/adapters/shared/marker-block';
import type { ItemDraft, ToolId } from '../../src/core/model/item';
import type { CompatibilityVerdict } from '../../src/core/model/plan';
import { removeTempTrees } from '../harness/isolation';
import { CLAUDE_EVENTS, hookArb, instructionArb, lf, markdownItemArb } from './generators';
import {
  exportOnce,
  makeStack,
  roundTrip,
  scanTool,
  viewOfDraft,
  viewOfStored,
  type ModelView,
} from './round-trip-stack';

/**
 * ROADMAP Etap 9 kryterium 7, ARCHITECTURE 12.1: `toCanonical(parse(apply(plan(x))))` rowna sie
 * `x` na poziomie modelu, dla kazdego eksportowanego typu elementu i obu narzedzi. Kazdy przebieg
 * idzie przez prawdziwy WriteGate na dysku i prawdziwy skan adaptera.
 *
 * Tam, gdzie werdykt jest `partial` albo `lossy`, oczekiwany wynik nie jest `x`, tylko `x` po
 * jawnej, wymienionej ponizej transformacji, a test sprawdza tez, ze werdykt ja zapowiada
 * (lostAttributes, addedAttributes). Transformacja, ktorej werdykt nie zapowiada, jest bledem.
 */

/**
 * Rozsadnie dla CI: kazdy przebieg to swieze drzewo, zapis z kopia i skan. 25 przebiegow to ok.
 * 6 s lokalnie i 20 s na runnerze macos-x64; przy 40 przebiegach ciezsze testy limitow
 * (library-round3) dobijaly obok do 5 s na obciazonym runnerze. Lokalnie przeszlo 400 przebiegow.
 */
// Lokalne polowanie na bledy: CWM_PROPERTY_RUNS=500 npx vitest run tests/property.
const RUNS = Number(process.env['CWM_PROPERTY_RUNS'] ?? 25);
const TIMEOUT_MS = 120_000;

afterAll(() => {
  removeTempTrees();
});

interface Expectation {
  readonly view: ModelView;
  readonly level: CompatibilityVerdict['level'];
  readonly lost: readonly string[];
  readonly added: readonly string[];
}

/**
 * Brak `name` i opis wyliczony: oba narzedzia wymagaja tych pol w pliku agenta, a Codex takze
 * w pliku skilla. Dopisane `name` to slug, dopisany opis wraca jako opis ze zrodla. Pusty opis
 * import traktuje jak brak (asText w frontmatter.ts), wiec wraca jako wyliczony, tez pusty.
 */
function withRequiredFields(
  x: ModelView,
  description: string,
): Pick<Expectation, 'added'> & {
  view: ModelView;
} {
  const added: string[] = [];
  if (x.declaredName === null) added.push('name');
  if (x.descriptionOrigin === 'derived') added.push('description');
  return {
    added,
    view: {
      ...x,
      declaredName: x.declaredName ?? x.slug,
      description,
      descriptionOrigin: description === '' ? 'derived' : 'source',
    },
  };
}

/** Oczekiwany wynik petli i werdykt, ktory musi go zapowiedziec. Jedno miejsce na wyjatki. */
function expectationFor(tool: ToolId, x: ModelView, title: string): Expectation {
  const full = (view: ModelView): Expectation => ({ view, level: 'full', lost: [], added: [] });
  if (tool === 'claude-code') {
    switch (x.kind) {
      case 'skill':
      case 'command':
      case 'hook':
        return full(x);
      case 'agent': {
        // Wyjatek lossy (ARCHITECTURE 4.3, addedAttributes): Claude Code wymaga name
        // i description w pliku agenta, wiec brakujace pola sa dopisywane.
        const { view, added } = withRequiredFields(x, x.description);
        return { view, level: added.length > 0 ? 'lossy' : 'full', lost: [], added };
      }
    }
  } else {
    switch (x.kind) {
      case 'skill':
      case 'command': {
        // Wyjatek lossy (ADR 0021, 0026, ARCHITECTURE 4.3): Codex wymaga frontmattera z name
        // i description; opis pusty zastepuje tytul (renderSkill w codex/export.ts).
        // Komenda staje sie skillem i traci wywolanie przez /nazwa (ADR 0021).
        const { view, added } = withRequiredFields(x, x.description !== '' ? x.description : title);
        const lossy =
          x.kind === 'command' ||
          added.length > 0 ||
          (x.declaredName !== null && x.declaredName !== x.slug);
        return {
          view: { ...view, kind: 'skill' },
          level: lossy ? 'lossy' : 'full',
          lost: x.kind === 'command' ? ['wywołanie przez /nazwa'] : [],
          added,
        };
      }
      case 'agent': {
        // Wyjatek partial (ARCHITECTURE 4.3, ADR 0011): color i memory nie maja odpowiednika
        // w Codeksie i nie wracaja; glebokosc rozumowania przechodzi przez
        // model_reasoning_effort i wraca ta sama. Brak name lub opisu: lossy jak u Claude'a.
        const { view, added } = withRequiredFields(x, x.description);
        const { presentation, memoryScope, ...kept } = view.attributes;
        const lost = [
          ...(presentation?.accentColor !== undefined ? ['color'] : []),
          ...(memoryScope !== undefined ? ['memory'] : []),
        ];
        return {
          view: { ...view, attributes: kept },
          level: added.length > 0 ? 'lossy' : 'partial',
          lost,
          added,
        };
      }
      case 'hook':
        // Wyjatek partial (ARCHITECTURE 4.3): Codex czyta tylko hooks.<Zdarzenie> i pomija
        // zdarzenia, ktorych nie zna. Na poziomie modelu hook wraca w calosci; partial dotyczy
        // tego, czy Codex go wykona, nie tego, co zapisano.
        return { view: x, level: 'partial', lost: [], added: [] };
    }
  }
  throw new Error(`brak oczekiwania dla ${tool}:${x.kind}`);
}

/** Tytul nie jest polem zadnego z narzedzi: import wylicza go ponownie (markdown-item.ts, hooks.ts). */
const titleFor = (view: ModelView, stored: string): string =>
  view.kind === 'hook' ? stored : (view.declaredName ?? firstHeading(view.body) ?? view.slug);

async function checkRoundTrip(tool: ToolId, draft: ItemDraft): Promise<void> {
  const rt = await roundTrip(tool, draft);
  const x = viewOfStored(rt.stored);
  // Tresc w bibliotece jest juz w LF, choc generator podaje tez CRLF i konce mieszane (ADR 0016).
  expect(x.body).toBe(lf(draft.content.body));

  const expected = expectationFor(tool, x, rt.stored.item.content.title);
  const verdict = rt.plan.verdicts.find((v) => v.itemId === rt.stored.item.id)?.verdict;
  expect(verdict?.level).toBe(expected.level);
  expect([...(verdict?.lostAttributes ?? [])].sort()).toEqual([...expected.lost].sort());
  expect([...(verdict?.addedAttributes ?? [])].sort()).toEqual([...expected.added].sort());

  const found = rt.candidates.filter(
    (c) => c.kind === expected.view.kind && c.draft.identity.slug === x.slug,
  );
  expect(found.map((c) => c.relPath)).toHaveLength(1);
  const back = found[0]!.draft;
  expect(viewOfDraft(back)).toEqual(expected.view);
  expect(back.content.title).toBe(titleFor(expected.view, rt.stored.item.content.title));
}

const CASES: readonly (readonly [string, ToolId, fc.Arbitrary<ItemDraft>])[] = [
  ['skill z plikami pomocniczymi', 'claude-code', markdownItemArb({ kind: 'skill', assets: true })],
  ['komenda', 'claude-code', markdownItemArb({ kind: 'command' })],
  ['agent', 'claude-code', markdownItemArb({ kind: 'agent' })],
  ['hook', 'claude-code', hookArb(CLAUDE_EVENTS)],
  ['skill z plikami pomocniczymi', 'codex', markdownItemArb({ kind: 'skill', assets: true })],
  ['komenda (staje sie skillem)', 'codex', markdownItemArb({ kind: 'command' })],
  ['agent (plik i wpis w config.toml)', 'codex', markdownItemArb({ kind: 'agent' })],
  ['hook', 'codex', hookArb(CLAUDE_EVENTS)],
];

describe('round-trip property-based: toCanonical(parse(apply(plan(x)))) (ARCHITECTURE 12.1)', () => {
  for (const [name, tool, arb] of CASES) {
    it(
      `${tool}: ${name}`,
      async () => {
        await fc.assert(
          fc.asyncProperty(arb, (draft) => checkRoundTrip(tool, draft)),
          { numRuns: RUNS },
        );
      },
      TIMEOUT_MS,
    );
  }

  /**
   * Wyjatek partial (ADR 0025): instrukcja globalna jest blokiem miedzy markerami w CLAUDE.md
   * i AGENTS.md. Import czyta caly plik, razem z markerami, wiec rowna `x` jest zawartosc bloku,
   * nie cala tresc elementu. Blok nie niesie koncowych pustych linii tresci (blockBody
   * w marker-block.ts), wiec porownanie idzie po tej samej normalizacji.
   */
  for (const tool of ['claude-code', 'codex'] as const) {
    it(
      `${tool}: instrukcja globalna wraca jako tresc bloku miedzy markerami`,
      async () => {
        await fc.assert(
          fc.asyncProperty(instructionArb, async (draft) => {
            const rt = await roundTrip(tool, draft);
            const verdict = rt.plan.verdicts[0]?.verdict;
            expect(verdict?.level).toBe('partial');
            const found = rt.candidates.filter((c) => c.kind === 'global-instruction');
            expect(found).toHaveLength(1);
            const body = found[0]!.draft.content.body;
            const start = body.indexOf(`${BLOCK_START}\n`);
            const end = body.lastIndexOf(BLOCK_END);
            expect(start).toBe(0);
            const inner = body.slice(start + BLOCK_START.length + 1, end);
            expect(inner).toBe(`${blockBody(rt.stored.item.content.body)}\n`);
          }),
          { numRuns: RUNS },
        );
      },
      TIMEOUT_MS,
    );
  }

  /**
   * Plik celu w CRLF (checkout z autocrlf, edytor na Windowsie): zapis zachowuje CRLF celu
   * (WriteGate), a import normalizuje do LF, wiec petla nadal daje `x`.
   */
  it(
    'claude-code: skill nadpisujacy plik w CRLF wraca rowny x, a plik zostaje w CRLF',
    async () => {
      await fc.assert(
        fc.asyncProperty(markdownItemArb({ kind: 'skill' }), async (draft) => {
          const stack = makeStack();
          const { item } = await stack.lib.service.create(draft);
          const stored = await stack.lib.service.get(item.id);
          const dir = join(stack.home, '.claude', 'skills', item.identity.slug);
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'SKILL.md'), '---\r\nname: stary\r\n---\r\nStara tresc.\r\n');
          await exportOnce(stack, 'claude-code', item.id);
          const back = (await scanTool(stack, 'claude-code')).find(
            (c) => c.kind === 'skill' && c.draft.identity.slug === item.identity.slug,
          );
          expect(viewOfDraft(back!.draft)).toEqual(viewOfStored(stored));
        }),
        { numRuns: 20 },
      );
    },
    TIMEOUT_MS,
  );
});
