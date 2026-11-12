#!/usr/bin/env node
import { CommanderError } from 'commander';

import { WriteDeniedError } from '../infra/cwm';
import { PathCheckError } from '../infra/cwm';
import { AtomicWriteError } from '../infra/fs/atomic';
import { errnoCode } from '../infra/fs/store-error';
import { CliError, printJson, safeText } from './context';
import { buildProgram } from './program';

const COMMANDER_OK = new Set(['commander.helpDisplayed', 'commander.version']);

/**
 * Komunikat bez surowego tekstu bledu systemowego: ten zawiera sciezki z dysku. Znane klasy bledow
 * maja wlasne, kontrolowane komunikaty, reszta dostaje tylko kod errno.
 */
function describe(error: unknown): string {
  if (error instanceof CliError || error instanceof WriteDeniedError) return error.message;
  if (error instanceof PathCheckError) return `Blad dostepu do sciezki: ${error.message}.`;
  if (error instanceof AtomicWriteError) return `Zapis odrzucony: ${error.message}`;
  return `Nieoczekiwany blad (${errnoCode(error) ?? 'nieznany'}).`;
}

function report(error: unknown, json: boolean, exitCode: 1 | 2): void {
  const message = describe(error);
  if (json) {
    if (message !== '') printJson({ ok: false, error: message });
  } else if (message !== '') {
    process.stderr.write(`${safeText(message)}\n`);
  }
  process.exitCode = exitCode;
}

async function main(): Promise<void> {
  // --json jest globalna opcja, ale blad moze wystapic, zanim commander ja sparsuje.
  const json = process.argv.includes('--json');
  try {
    await buildProgram().parseAsync(process.argv);
  } catch (error: unknown) {
    if (error instanceof CommanderError) {
      process.exitCode = COMMANDER_OK.has(error.code) ? 0 : 2;
    } else {
      report(error, json, error instanceof CliError ? error.exitCode : 1);
    }
  }
}

void main();
