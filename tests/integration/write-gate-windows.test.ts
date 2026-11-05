import { execFileSync, spawn } from 'node:child_process';
import { closeSync, constants, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { WritePlan } from '../../src/core/model/plan';
import { removeTempTrees } from '../harness/isolation';

import {
  entry,
  expectNoBytesWritten,
  makeFixture,
  makePlan,
  text,
  type Fixture,
} from './write-gate-fixture';

/**
 * Kryterium 8 Etapu 5, przyczyny istniejace tylko na Windowsie (ADR 0028): naruszenie
 * wspoldzielenia i ACL z zapisem bez odczytu. Oba przypadki maja obie kolumny z ARCHITECTURE
 * 12.5: z przyczyna plan jest `blocked` i `apply` nic nie zapisuje, bez niej plan jest
 * `recoverable`. Uruchamiane w CI w jobie windows-x64.
 */

afterAll(() => {
  removeTempTrees();
});

const windowsOnly = it.runIf(process.platform === 'win32');
const CHILD_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 90_000;
const CONTENT = 'tresc acme do skopiowania\n';
const TARGET = 'acme-zablokowany.md';

interface HeldLock {
  release(): Promise<void>;
}

/**
 * Node nie otwiera pliku z FileShare.None, wiec blokade trzyma potomny PowerShell. Sciezka idzie
 * przez zmienna srodowiskowa, nie przez tekst skryptu. Proces konczy sie po linii na stdin.
 */
async function holdExclusive(file: string): Promise<HeldLock> {
  const script = [
    "$f = [System.IO.File]::Open($env:ACME_LOCK_PATH, 'Open', 'ReadWrite', 'None')",
    "[Console]::Out.WriteLine('zablokowany')",
    '[Console]::Out.Flush()',
    '[void][Console]::In.ReadLine()',
    '$f.Close()',
  ].join('; ');
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      env: { ...process.env, ACME_LOCK_PATH: file },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

  await new Promise<void>((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`PowerShell nie zalozyl blokady w czasie: ${err}`));
    }, CHILD_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('zablokowany')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`PowerShell zakonczyl sie przed blokada (kod ${String(code)}): ${err}`));
    });
  });

  return {
    async release() {
      if (child.exitCode === null) {
        child.stdin.end('\n');
        const killer = setTimeout(() => child.kill(), CHILD_TIMEOUT_MS);
        await exited;
        clearTimeout(killer);
      }
    },
  };
}

/** ACL tylko z prawem zapisu dla biezacego konta, bez dziedziczenia. */
function grantWriteOnly(file: string): void {
  const account = execFileSync('whoami', { encoding: 'utf8' }).trim();
  execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${account}:(W)`]);
}

/** Wlasciciel ma niejawne WRITE_DAC, wiec /reset przywraca dziedziczone ACL bez prawa odczytu. */
function resetAcl(file: string): void {
  execFileSync('icacls', [file, '/reset']);
}

function modifyPlan(): WritePlan {
  return makePlan([
    entry({ relPath: TARGET, action: 'modify', previous: text(CONTENT), content: text('nowa\n') }),
  ]);
}

function prepare(): { f: Fixture; file: string } {
  const f = makeFixture();
  const file = join(f.skillsRoot, TARGET);
  writeFileSync(file, CONTENT);
  return { f, file };
}

async function expectBlockedWithoutPath(f: Fixture, reasonPattern: RegExp): Promise<void> {
  const probed = await f.gate.probe(modifyPlan());
  const verdict = probed.entries[0]?.recoverability;
  expect(probed.applicable).toBe(false);
  expect(verdict?.status).toBe('blocked');
  const reason = verdict?.reason ?? '';
  expect(reason).toMatch(reasonPattern);
  expect(reason).not.toContain(f.tree);
  expect(reason).not.toContain(TARGET);
  await expectNoBytesWritten(f, modifyPlan());
}

async function expectRecoverable(f: Fixture): Promise<void> {
  const probed = await f.gate.probe(modifyPlan());
  expect(probed.entries[0]?.recoverability?.status).toBe('recoverable');
  expect(probed.applicable).toBe(true);
}

describe('naruszenie wspoldzielenia na Windowsie (kryterium 8)', () => {
  windowsOnly(
    'plik otwarty przez inny proces bez wspoldzielenia: blocked, a apply nic nie zapisuje',
    async () => {
      const { f, file } = prepare();
      const lock = await holdExclusive(file);
      try {
        // Przeslanka testu: odczyt naprawde pada, inaczej test niczego nie dowodzi.
        expect(() => readFileSync(file)).toThrow(/EBUSY|EPERM|EACCES/);
        await expectBlockedWithoutPath(f, /otwarty przez inny program/);
      } finally {
        await lock.release();
      }
      expect(readFileSync(file, 'utf8')).toBe(CONTENT);
    },
    TEST_TIMEOUT_MS,
  );

  windowsOnly(
    'po zwolnieniu blokady ten sam plan jest recoverable',
    async () => {
      const { f, file } = prepare();
      const lock = await holdExclusive(file);
      try {
        expect((await f.gate.probe(modifyPlan())).applicable).toBe(false);
      } finally {
        await lock.release();
      }
      await expectRecoverable(f);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('ACL z zapisem bez odczytu na Windowsie (kryterium 8)', () => {
  windowsOnly(
    'zapis dozwolony, odczyt zabroniony: blocked, a apply nic nie zapisuje',
    async () => {
      const { f, file } = prepare();
      grantWriteOnly(file);
      try {
        // Przeslanki: odczyt pada, a otwarcie do zapisu przechodzi (zapis by sie udal).
        expect(() => readFileSync(file)).toThrow(/EPERM|EACCES/);
        closeSync(openSync(file, constants.O_WRONLY));
        await expectBlockedWithoutPath(f, /nieczytelny|Brak dostępu/);
      } finally {
        resetAcl(file);
      }
      expect(readFileSync(file, 'utf8')).toBe(CONTENT);
    },
    TEST_TIMEOUT_MS,
  );

  windowsOnly(
    'po przywroceniu ACL ten sam plan jest recoverable',
    async () => {
      const { f, file } = prepare();
      grantWriteOnly(file);
      try {
        expect((await f.gate.probe(modifyPlan())).applicable).toBe(false);
      } finally {
        resetAcl(file);
      }
      await expectRecoverable(f);
    },
    TEST_TIMEOUT_MS,
  );
});
