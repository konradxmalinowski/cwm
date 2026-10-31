import { join } from 'node:path';

import type { AssetInput, ItemDraft, ItemKind } from '../../src/core/model/item';
import { createUlidGenerator } from '../../src/core/ports/id-generator';
import { LibraryService } from '../../src/core/services/library/library-service';
import { FsLibraryStore } from '../../src/infra/library/library-store';
import { FsObjectStore } from '../../src/infra/store/object-store';
import { FakeClock, MemoryOperationLog, bytes, deterministicRandom } from '../unit/library-fakes';

/**
 * Specyfikacja drzewa `tests/fixtures/library-linux/` (kryterium 10). Drzewo jest generowane
 * przez `LibraryService` z tej listy, a test odczytu porownuje bajty z ta sama lista, wiec
 * oczekiwane wartosci nie pochodza z plikow, ktore sprawdzamy.
 */

export const FIXTURE_DIR = 'tests/fixtures/library-linux';

/** Snapshot zrodla z CRLF w bajtach: git bez `-text` zamienilby go na LF i hash by sie rozjechal. */
export const CRLF_SOURCE = bytes(
  '---\r\nname: acme-deploy\r\ndescription: Wdrozenie acme.\r\n---\r\n\r\nUruchom wdrozenie.\r\n',
);

/** Bajty, ktore kazda konwersja tekstowa by zmienila: CR, LF, CRLF, NUL, bajty spoza UTF-8. */
export const BINARY_ASSET = Uint8Array.from([0x00, 0x0d, 0x0a, 0x0a, 0x0d, 0xff, 0xfe, 0x41, 0x0d]);

export const DEEP_ASSET = 'p1/p2/p3/p4/p5/p6/p7/p8/p9/p10/acme-deep.txt';

export interface FixtureItem {
  readonly draft: ItemDraft;
  /** Druga wersja zapisana przez `update`, zeby w `objects/` byla historia do `restoreVersion`. */
  readonly update?: ItemDraft;
}

const asset = (relPath: string, content: string | Uint8Array): AssetInput => ({
  relPath,
  bytes: typeof content === 'string' ? bytes(content) : content,
});

function base(
  kind: ItemKind,
  slug: string,
  body: string,
  extra: Partial<ItemDraft> = {},
): ItemDraft {
  return {
    kind,
    identity: { slug, declaredName: slug, aliases: [] },
    content: {
      title: slug,
      description: `Syntetyczny element ${slug}.`,
      descriptionOrigin: 'source',
      body,
    },
    ...extra,
  };
}

export const FIXTURE_ITEMS: readonly FixtureItem[] = [
  {
    draft: base('skill', 'acme-review', '# Acme review\n\nSprawdz zmiany w repozytorium acme.\n', {
      assets: [
        asset('acme notes/read me.md', 'nazwa ze spacjami\n'),
        asset('zażółć gęślą jaźń.md', 'polskie znaki w NFC\n'),
        asset('資料/説明.md', 'CJK\n'),
        asset(DEEP_ASSET, 'dziesiec poziomow\n'),
        asset('Makefile', 'acme:\n\techo acme\n'),
        asset('bin/acme.dat', BINARY_ASSET),
      ],
    }),
  },
  {
    // Ten sam slug, inny typ: klucz unikalnosci to lower(slug) + kind (ADR 0017).
    draft: base('agent', 'acme-review', 'Agent przegladu acme.\n'),
  },
  {
    // Rozjechany slug i declaredName to stan poprawny, tylko ostrzezenie (ADR 0026).
    draft: {
      ...base('agent', 'acme-planner', 'Planuje prace acme.\n'),
      identity: { slug: 'acme-planner', declaredName: 'acme-architect', aliases: [] },
    },
    update: {
      ...base('agent', 'acme-planner', 'Planuje prace acme, wersja druga.\n'),
      identity: { slug: 'acme-planner', declaredName: 'acme-architect', aliases: [] },
    },
  },
  {
    draft: base('command', 'acme-deploy', 'Uruchom wdrozenie.\n', {
      source: {
        snapshots: [
          {
            tool: 'claude-code',
            files: [{ relPath: 'commands/acme-deploy.md', bytes: CRLF_SOURCE, mode: 0o644 }],
            unmappedKeys: [],
          },
        ],
        importedFrom: {
          tool: 'claude-code',
          rootId: 'acme-root-1',
          path: 'commands/acme-deploy.md',
          at: '2026-10-30T12:00:00.000Z',
        },
      },
    }),
  },
  {
    draft: base('rule', 'acme-style', ''),
  },
  {
    draft: base('hook', 'acme-format-hook', 'Formatowanie po edycji.\n', {
      attributes: {
        hook: {
          event: 'PostToolUse',
          matcher: 'Edit',
          command: 'acme-format --check',
          pathStyle: 'home-relative',
          timeoutSeconds: 30,
        },
      },
    }),
  },
  {
    draft: base('tool-setting', 'acme-model', 'Model domyslny.\n', {
      attributes: { toolSetting: { tool: 'codex', key: 'model', value: 'acme-large' } },
    }),
  },
];

/** Deterministycznie: staly zegar i losowosc daja te same id i te same bajty na kazdym systemie. */
export async function generateFixtureLibrary(root: string): Promise<void> {
  const clock = new FakeClock();
  const service = new LibraryService({
    store: new FsLibraryStore(join(root, 'library')),
    objects: new FsObjectStore(join(root, 'objects')),
    log: new MemoryOperationLog(),
    ids: createUlidGenerator(clock, deterministicRandom()),
    clock,
  });
  for (const entry of FIXTURE_ITEMS) {
    clock.advance(1000);
    const { item } = await service.create(entry.draft);
    if (entry.update !== undefined) {
      clock.advance(1000);
      await service.update(item.id, entry.update);
    }
  }
}
