import { describe, expect, it } from 'vitest';

import {
  ExportError,
  PLAN_TTL_MS,
  materializationFor,
  redactPaths,
} from '../../src/core/services/export/export-service';
import { root } from './import-fakes';
import { emptyPlan, entry, exportHarness } from './export-fakes';

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof ExportError) return error.code;
    throw error;
  }
  return 'brak-bledu';
}

describe('ExportService.plan', () => {
  it('woła eksportera z rootami narzedzia i materializacja z wykrytej zdolnosci', async () => {
    const h = await exportHarness({
      roots: [root('r-claude', 'claude-code'), root('r-codex', 'codex')],
    });
    const report = await h.service.plan('claude-code', [h.itemId]);

    expect(report.toolMissing).toBe(false);
    expect(h.exporter.contexts[0]?.roots.map((r) => r.rootId)).toEqual(['r-claude']);
    expect(h.exporter.contexts[0]?.materialization).toEqual({
      directory: 'junction',
      file: 'symlink',
    });
    expect(h.exporter.seen[0]?.[0]?.item.id).toBe(h.itemId);
    expect(h.gate.probes).toBe(1);
    expect(report.plan.entries).toHaveLength(1);
    expect(report.entryIds).toEqual(['e1']);
    expect(report.plan.planId).toBe('plan-1');
  });

  it('brak katalogu narzedzia: plan toolMissing bez wpisow, bez wołania eksportera i bramki', async () => {
    const h = await exportHarness({ roots: [root('r-claude', 'claude-code', { exists: false })] });
    const report = await h.service.plan('claude-code', [h.itemId]);

    expect(report.toolMissing).toBe(true);
    expect(report.plan.entries).toEqual([]);
    expect(report.plan.applicable).toBe(false);
    expect(h.exporter.contexts).toHaveLength(0);
    expect(h.gate.probes).toBe(0);
    expect(await code(h.service.apply(report.planId, true))).toBe('unknown-plan');
  });

  it('narzedzie bez eksportera i pusty wybor sa odmowione', async () => {
    const h = await exportHarness();
    expect(await code(h.service.plan('codex', [h.itemId]))).toBe('unsupported-tool');
    expect(await code(h.service.plan('claude-code', []))).toBe('no-items');
  });

  it('nieznany element biblioteki konczy sie bledem biblioteki', async () => {
    const h = await exportHarness();
    await expect(h.service.plan('claude-code', ['01ZZZZZZZZZZZZZZZZZZZZZZZZ'])).rejects.toThrow();
  });

  it('dubli w itemIds nie przekazuje dalej', async () => {
    const h = await exportHarness();
    await h.service.plan('claude-code', [h.itemId, h.itemId]);
    expect(h.exporter.seen[0]).toHaveLength(1);
  });
});

describe('ExportService.apply', () => {
  it('bez zatwierdzenia odmawia i nie zuzywa planu', async () => {
    const h = await exportHarness();
    const { planId } = await h.service.plan('claude-code', [h.itemId]);

    expect(await code(h.service.apply(planId, false))).toBe('not-approved');
    expect(h.gate.applies).toHaveLength(0);
    const ok = await h.service.apply(planId, true);
    expect(ok.verified).toBe(true);
  });

  it('zatwierdzony plan trafia do bramki z planId i mapuje wpisy na entryId', async () => {
    const h = await exportHarness();
    const { planId } = await h.service.plan('claude-code', [h.itemId]);
    const applied = await h.service.apply(planId, true);

    expect(h.gate.applies).toHaveLength(1);
    expect(h.gate.applies[0]?.planId).toBe(planId);
    expect(applied).toMatchObject({
      planId,
      backupId: 'backup-1',
      entries: [{ entryId: 'e1', outcome: 'written', message: null }],
      verified: true,
      rolledBack: false,
    });
  });

  it('plan jest jednorazowy', async () => {
    const h = await exportHarness();
    const { planId } = await h.service.plan('claude-code', [h.itemId]);
    await h.service.apply(planId, true);

    expect(await code(h.service.apply(planId, true))).toBe('unknown-plan');
    expect(h.gate.applies).toHaveLength(1);
  });

  it('plan wygasly jest odmowiony i zuzyty', async () => {
    const h = await exportHarness();
    const { planId } = await h.service.plan('claude-code', [h.itemId]);
    h.clock.advance(PLAN_TTL_MS + 1);

    expect(await code(h.service.apply(planId, true))).toBe('plan-expired');
    expect(await code(h.service.apply(planId, true))).toBe('unknown-plan');
    expect(h.gate.applies).toHaveLength(0);
  });

  it('plan nieaplikowalny jest odmowiony bez wolania bramki', async () => {
    const h = await exportHarness({
      build: () => emptyPlan({ entries: [entry()], applicable: false }),
    });
    const { planId } = await h.service.plan('claude-code', [h.itemId]);

    expect(await code(h.service.apply(planId, true))).toBe('plan-not-applicable');
    expect(h.gate.applies).toHaveLength(0);
  });

  it('nieznany planId i plan podany przez renderer nie istnieja', async () => {
    const h = await exportHarness();
    expect(await code(h.service.apply('wymyslony', true))).toBe('unknown-plan');
  });

  it('wyjatek bramki daje raport "failed" z ogolnym komunikatem, bez tresci bledu', async () => {
    const logged: unknown[] = [];
    const h = await exportHarness({ overrides: { onUnexpected: (e) => logged.push(e) } });
    h.gate.apply = () => Promise.reject(new Error('/Users/ktos/.claude/sekret'));
    const { planId } = await h.service.plan('claude-code', [h.itemId]);
    const applied = await h.service.apply(planId, true);

    expect(applied.entries[0]).toMatchObject({ entryId: 'e1', outcome: 'failed' });
    expect(JSON.stringify(applied)).not.toContain('/Users');
    expect(logged).toHaveLength(1);
  });

  it('komunikat bramki ze sciezka bezwzgledna jest oczyszczony', async () => {
    const h = await exportHarness();
    h.gate.apply = (plan) =>
      Promise.resolve({
        planId: plan.planId,
        backupId: 'b',
        entries: plan.entries.map((e) => ({
          rootId: e.rootId,
          relPath: e.relPath,
          outcome: 'failed' as const,
          message: 'EACCES: /Users/ktos/.claude/skills/x nie do zapisu',
        })),
        verified: false,
        rolledBack: true,
      });
    const { planId } = await h.service.plan('claude-code', [h.itemId]);
    const applied = await h.service.apply(planId, true);
    expect(applied.entries[0]?.message).not.toContain('/Users');
  });

  it('odmowa bramki przed zapisem wraca jako blad z jej powodem, nie jako nieudany zapis', async () => {
    const h = await exportHarness();
    h.gate.apply = () => {
      const refusal = Object.assign(
        new Error('Plik zmienił się od przygotowania planu: /Users/ktos/.claude/CLAUDE.md'),
        { name: 'WriteGateRefusal', code: 'plan-changed' },
      );
      return Promise.reject(refusal);
    };
    const { planId } = await h.service.plan('claude-code', [h.itemId]);
    const failure = await h.service.apply(planId, true).catch((e: unknown) => e);

    expect(failure).toMatchObject({ code: 'gate-plan-changed' });
    expect((failure as Error).message).toContain('Plik zmienił się od przygotowania planu');
    expect((failure as Error).message).not.toContain('/Users');
  });
});

describe('pomocnicze', () => {
  it('materializationFor wybiera najlepszy tryb albo kopie', () => {
    expect(
      materializationFor({ fileSymlink: true, directorySymlink: true, junction: false }),
    ).toEqual({ directory: 'symlink', file: 'symlink' });
    expect(
      materializationFor({ fileSymlink: false, directorySymlink: false, junction: false }),
    ).toEqual({ directory: 'copy', file: 'copy' });
  });

  it('redactPaths nie rusza sciezek wzglednych', () => {
    expect(redactPaths('plik skills/acme/SKILL.md')).toBe('plik skills/acme/SKILL.md');
    expect(redactPaths('C:\\Users\\x\\a.md blad')).toBe('<sciezka> blad');
  });
});
