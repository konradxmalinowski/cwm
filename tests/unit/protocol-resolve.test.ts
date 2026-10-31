import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

// protocol.ts importuje `electron`; do sprawdzenia samego `resolveTarget` wystarczy atrapa.
vi.mock('electron', () => ({ protocol: {} }));

import { resolveTarget } from '../../src/main/bootstrap/protocol';
import { createTempTree, removeTempTrees } from '../harness/isolation';

afterAll(() => {
  removeTempTrees();
});

describe('resolveTarget', () => {
  function root(): string {
    const dir = createTempTree('acme-protocol-');
    writeFileSync(join(dir, 'index.html'), '<html></html>');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'app.js'), 'x');
    return dir;
  }

  it('zniekszatlcona sekwencja % daje wynik malformed, a nie wyjatek', async () => {
    const dir = root();
    for (const pathname of ['/%', '/%E0%A4%A', '/assets/%zz', '/%C0%AF']) {
      await expect(resolveTarget(dir, pathname)).resolves.toEqual({ kind: 'malformed' });
    }
  });

  it('plik, powloka trasy i wyjscie poza katalog', async () => {
    const dir = root();
    await expect(resolveTarget(dir, '/assets/app.js')).resolves.toEqual({
      kind: 'file',
      path: join(dir, 'assets', 'app.js'),
    });
    await expect(resolveTarget(dir, '/trasa')).resolves.toEqual({
      kind: 'file',
      path: join(dir, 'index.html'),
    });
    await expect(resolveTarget(dir, '/%2e%2e/etc/passwd')).resolves.toEqual({ kind: 'outside' });
    await expect(resolveTarget(dir, '/brak.js')).resolves.toEqual({ kind: 'missing' });
  });
});
