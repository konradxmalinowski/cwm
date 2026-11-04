import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createLogger, logFilePath } from '../../src/infra/logging/logger';
import { SECRETS, filler } from '../unit/security-secrets';
import { createTempTree, removeTempTrees } from '../harness/isolation';

afterEach(removeTempTrees);

describe('logger do pliku (kryterium 5: sekret nie trafia do logu)', () => {
  it('plik logu nie zawiera sekretow ani katalogu domowego', () => {
    const userData = createTempTree('acme-log-');
    const home = join(userData, 'acme-home');
    const echoed: string[] = [];
    const logger = createLogger({
      logFile: logFilePath(userData),
      homeDir: home,
      echo: (l) => echoed.push(l),
    });
    const assigned = `${filler(12, 21)}4${filler(12, 22)}`;
    logger.error(
      'blad',
      new Error(`ENOENT ${join(home, '.codex', 'auth.json')} ${SECRETS.openai}`),
    );
    logger.warn(`token=${assigned} oraz ${SECRETS.github}`);
    logger.info('obiekt', { header: `Bearer ${SECRETS.openai}`, path: join(home, 'x') });
    logger.info(`${SECRETS.pemBegin} ${filler(40, 2)}`);

    const content = readFileSync(logFilePath(userData), 'utf8');
    for (const forbidden of [SECRETS.openai, SECRETS.github, assigned, home, filler(40, 2)]) {
      expect(content).not.toContain(forbidden);
      expect(echoed.join('\n')).not.toContain(forbidden);
    }
    expect(content).toContain('[ukryty sekret:');
    expect(content).toContain(
      '~/.codex/auth.json'.replaceAll('/', content.includes('~\\') ? '\\' : '/'),
    );
  });

  it('znak nowej linii w komunikacie nie tworzy falszywego wpisu', () => {
    const userData = createTempTree('acme-log-');
    const logger = createLogger({ logFile: logFilePath(userData), homeDir: '/h', echo: null });
    logger.info('a\n2026-01-01T00:00:00.000Z ERROR podrobiony');
    const lines = readFileSync(logFilePath(userData), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('rotuje plik po przekroczeniu limitu i nie rzuca przy niezapisywalnym katalogu', () => {
    const userData = createTempTree('acme-log-');
    const file = logFilePath(userData);
    const logger = createLogger({ logFile: file, homeDir: '/h', echo: null, maxBytes: 200 });
    for (let i = 0; i < 20; i++) logger.info(`wpis numer ${i} z dluzsza trescia`);
    expect(existsSync(`${file}.1`)).toBe(true);

    const blocker = join(userData, 'plik');
    writeFileSync(blocker, 'x');
    const broken = createLogger({
      logFile: join(blocker, 'logs', 'app.log'),
      homeDir: '/h',
      echo: null,
    });
    expect(() => broken.error('nic sie nie dzieje')).not.toThrow();
  });
});
