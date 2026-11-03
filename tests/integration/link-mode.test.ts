import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { chooseMaterialization, LinkCapabilityDetector } from '../../src/infra/fs/link-mode';
import { createTempTree, removeTempTrees } from '../harness/isolation';

afterAll(() => {
  removeTempTrees();
});

const posixOnly = it.skipIf(process.platform === 'win32');
const eperm = () => Promise.reject(Object.assign(new Error('EPERM'), { code: 'EPERM' }));

describe('wykrywanie zdolnosci dowiazan (ADR 0015)', () => {
  it('na tym systemie wykrywa zdolnosc proba i nie zostawia sladow w userData', async () => {
    const userData = createTempTree('acme-link-');
    const detector = new LinkCapabilityDetector(userData);
    const capability = await detector.capability();

    if (process.platform === 'win32') {
      // Windows bez uprawnien: symlinki moga byc niedostepne, junction ma dzialac zawsze.
      expect(capability.junction).toBe(true);
    } else {
      expect(capability).toEqual({ fileSymlink: true, directorySymlink: true, junction: false });
    }
    expect(existsSync(join(userData, 'tmp'))).toBe(true);
    expect(readdirSync(join(userData, 'tmp'))).toEqual([]);
  });

  it('zapamietuje wynik, a recheck probuje od nowa', async () => {
    const userData = createTempTree('acme-link-');
    let attempts = 0;
    let allowed = false;
    const detector = new LinkCapabilityDetector(userData, {
      ops: {
        symlink: async (target, path, type) => {
          attempts++;
          if (!allowed) return eperm();
          const { symlink } = await import('node:fs/promises');
          await symlink(target, path, type);
        },
      },
    });
    const first = await detector.capability();
    expect(first).toEqual({ fileSymlink: false, directorySymlink: false, junction: false });
    const afterFirst = attempts;
    expect(await detector.capability()).toBe(first);
    expect(attempts).toBe(afterFirst);

    allowed = true;
    const again = await detector.recheck();
    expect(attempts).toBeGreaterThan(afterFirst);
    expect(again.fileSymlink).toBe(true);
    expect(await detector.capability()).toBe(again);
  });

  it('Windows bez uprawnienia: symlinki odmowione, junction dziala', async () => {
    const userData = createTempTree('acme-link-');
    const detector = new LinkCapabilityDetector(userData, {
      platform: 'win32',
      ops: {
        symlink: async (target, path, type) => {
          if (type !== 'junction') return eperm();
          const { symlink } = await import('node:fs/promises');
          await symlink(target, path);
        },
      },
    });
    expect(await detector.capability()).toEqual({
      fileSymlink: false,
      directorySymlink: false,
      junction: true,
    });
  });

  it('userData, w ktorym nie da sie utworzyc katalogu probnego, daje brak zdolnosci', async () => {
    const userData = createTempTree('acme-link-');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(userData, 'tmp'), 'plik zamiast katalogu');
    const capability = await new LinkCapabilityDetector(userData).capability();
    expect(capability).toEqual({ fileSymlink: false, directorySymlink: false, junction: false });
  });

  posixOnly('katalog probny nie zalezy od istnienia userData', async () => {
    const base = createTempTree('acme-link-');
    const userData = join(base, 'jeszcze', 'nie-ma');
    mkdirSync(base, { recursive: true });
    expect((await new LinkCapabilityDetector(userData).capability()).fileSymlink).toBe(true);
  });
});

describe('tabela degradacji (ADR 0015)', () => {
  const full = { fileSymlink: true, directorySymlink: true, junction: false };
  const winNoPrivilege = { fileSymlink: false, directorySymlink: false, junction: true };
  const none = { fileSymlink: false, directorySymlink: false, junction: false };

  it('macOS, Linux i Windows z uprawnieniem: symlink dla pliku i katalogu', () => {
    expect(chooseMaterialization(full, 'file', null)).toEqual({
      mode: 'symlink',
      degradedReason: null,
    });
    expect(chooseMaterialization(full, 'directory', 'symlink').mode).toBe('symlink');
  });

  it('Windows bez uprawnienia: junction dla katalogu z komentarzem, kopia dla pliku', () => {
    const dir = chooseMaterialization(winNoPrivilege, 'directory', null);
    expect(dir.mode).toBe('junction');
    expect(dir.degradedReason).toContain('junction');
    const file = chooseMaterialization(winNoPrivilege, 'file', null);
    expect(file.mode).toBe('copy');
    expect(file.degradedReason).toContain('kopię');
  });

  it('brak jakiejkolwiek zdolnosci: kopia, z przyczyna', () => {
    expect(chooseMaterialization(none, 'directory', null).mode).toBe('copy');
    expect(chooseMaterialization(none, 'directory', null).degradedReason).not.toBeNull();
  });

  it('kopia zazadana przez adapter nie jest degradacja', () => {
    expect(chooseMaterialization(full, 'file', 'copy')).toEqual({
      mode: 'copy',
      degradedReason: null,
    });
  });
});
