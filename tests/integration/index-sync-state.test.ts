import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';

import type { ItemId, Sha256 } from '../../src/core/model/item';
import { SCHEMA_VERSION, SqliteIndexStore } from '../../src/infra/db/index-store';
import { createTempTree, removeTempTrees } from '../harness/isolation';

afterAll(() => {
  removeTempTrees();
});

const id = 'ITEM1' as ItemId;
const hash = 'a'.repeat(64) as Sha256;

describe('indeks: stan synchronizacji i grupowanie logu', () => {
  it('schemat ma wersje 4', () => {
    expect(SCHEMA_VERSION).toBe(4);
  });

  it('zapisuje, czyta, nadpisuje i usuwa rekord', async () => {
    const tree = createTempTree('acme-db-');
    const store = SqliteIndexStore.open(join(tree, 'index.db'), { home: tree });
    const state = store.syncState();
    const record = {
      itemId: id,
      tool: 'codex' as const,
      itemRevision: 1,
      itemContentHash: hash,
      files: [
        { rootId: 'r', relPath: 'a/SKILL.md', writtenHash: hash, scope: 'whole-file' as const },
      ],
      syncedAt: '2026-11-04T10:00:00.000Z',
      backupId: 'b1',
    };
    await state.put(record);
    expect(await state.get(id, 'codex')).toEqual(record);
    expect(await state.get(id, 'claude-code')).toBeNull();
    await state.put({ ...record, itemRevision: 2 });
    expect((await state.list('codex')).map((r) => r.itemRevision)).toEqual([2]);
    await state.remove(id, 'codex');
    expect(await state.list()).toEqual([]);
    store.close();
  });

  it('grupuje wiersze jednej kopii i wskazuje operacje cofajaca', async () => {
    const tree = createTempTree('acme-db-');
    const store = SqliteIndexStore.open(join(tree, 'index.db'), { home: tree });
    const log = store.operationLog();
    const base = { itemKind: null, slug: null, at: 'T', before: null, after: null };
    await log.append({ ...base, operation: 'export', itemId: id, tool: 'codex', backupId: 'b1' });
    await log.append({ ...base, operation: 'sync', itemId: id, tool: 'codex', backupId: 'b1' });
    await log.append({ ...base, operation: 'create', itemId: id });
    await log.append({
      ...base,
      operation: 'rollback',
      itemId: id,
      tool: 'codex',
      backupId: 'b2',
      reverts: 'b1',
    });

    const reader = store.operationLogReader();
    const groups = await reader.groups(10);
    expect(groups.map((g) => g.key)).toEqual(['backup:b2', 'seq:3', 'backup:b1']);
    expect(groups[2]?.rows).toHaveLength(2);
    expect((await reader.groups(10, 'seq:3')).map((g) => g.key)).toEqual(['backup:b1']);
    expect(await reader.revertedBy('b1')).toBe('backup:b2');
    expect(await reader.revertedBy('b2')).toBeNull();
    expect(await reader.group('brak')).toBeNull();
    store.close();
  });

  it('odmawia schematu z przyszlosci (ADR 0029)', () => {
    const tree = createTempTree('acme-db-');
    const path = join(tree, 'index.db');
    SqliteIndexStore.open(path, { home: tree }).close();
    const db = new Database(path);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
      SCHEMA_VERSION + 1,
      'T',
    );
    db.close();
    expect(() => SqliteIndexStore.open(path, { home: tree })).toThrow(/schematu/);
  });
});
