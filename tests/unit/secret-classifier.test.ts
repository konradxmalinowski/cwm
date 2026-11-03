import { describe, expect, it } from 'vitest';

import {
  classifySecrets,
  classifyStructured,
  shannonEntropy,
  type SecretHit,
} from '../../src/core/services/security/secret-classifier';
import { bytes } from './library-fakes';

/**
 * Wartosci testowe sa skladane w locie z kawalkow, zeby zrodlo testu nie zawieralo zadnego
 * ciagu, ktory gitleaks w CI uznalby za prawdziwy klucz (ADR 0004). Losowosc jest deterministyczna.
 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function filler(length: number, seed = 7): string {
  let state = seed;
  let out = '';
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out += ALPHABET.charAt(state % ALPHABET.length);
  }
  return out;
}

const OPENAI_LIKE = ['s', 'k', '-', filler(40)].join('');
const GITHUB_LIKE = ['g', 'h', 'p', '_', filler(36, 11)].join('');
const AWS_LIKE = ['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join('');
const PEM_PRIVATE = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
const PEM_CERT = ['-----BEGIN', 'CERTIFICATE-----'].join(' ');
const RANDOM_TOKEN = filler(44, 23);

function scan(relPath: string, text: string): SecretHit[] {
  return classifySecrets([{ relPath, bytes: bytes(text) }]);
}

function rules(hits: readonly SecretHit[]): string[] {
  return hits.map((h) => h.rule);
}

describe('klasyfikator sekretow: kolumna pozytywna (ma oznaczyc)', () => {
  it('rozpoznaje pliki po nazwie i rozszerzeniu, bez czytania tresci', () => {
    for (const name of [
      'auth.json',
      '.env',
      '.env.production',
      'server.pem',
      'tls/private.key',
      'bundle.p12',
      'store.pfx',
      'id_rsa',
      'credentials.json',
      'aws-credentials',
    ]) {
      const hits = scan(name, 'nic ciekawego w srodku\n');
      expect(rules(hits), name).toContain('file-name');
      expect(hits[0]?.relPath).toBe(name);
      expect(hits[0]?.line).toBeNull();
    }
  });

  it('rozpoznaje wzorce znanych kluczy z numerem linii', () => {
    const text = [
      'Linia pierwsza bez niczego.',
      `Klucz: ${OPENAI_LIKE}`,
      `token=${GITHUB_LIKE}`,
      `aws ${AWS_LIKE} koniec`,
      PEM_PRIVATE,
    ].join('\n');
    const hits = scan('SKILL.md', text).filter((h) => h.rule === 'known-key');
    expect(hits.map((h) => h.line)).toEqual([2, 3, 4, 5]);
    expect(hits.every((h) => h.confidence === 'high')).toBe(true);
  });

  it('rozpoznaje dlugi ciag o wysokiej entropii', () => {
    expect(shannonEntropy(RANDOM_TOKEN)).toBeGreaterThan(4.2);
    const hits = scan('notes.md', `Uzyj wartosci ${RANDOM_TOKEN} w naglowku.`);
    expect(rules(hits)).toEqual(['entropy']);
    expect(hits[0]?.line).toBe(1);
  });

  it('rozpoznaje nazwe klucza w YAML, JSON, TOML i .env', () => {
    const value = filler(20, 5);
    const cases = [
      `api_key: ${value}`,
      `"password": "${value}"`,
      `token = "${value}"`,
      `ACME_SECRET=${value}`,
    ];
    for (const text of cases) {
      expect(rules(scan('config.txt', text)), text).toContain('key-name');
    }
  });

  it('rozpoznaje nazwe klucza w strukturze, ktorej adapter nie zmapowal', () => {
    const hits = classifyStructured('server.json', [
      { path: 'mcpServers.acme.env', value: { ACME_TOKEN: filler(24, 3), LOG_LEVEL: 'debug' } },
      { path: 'headers', value: [{ password: filler(18, 9) }] },
    ]);
    expect(hits.map((h) => h.rule)).toEqual(['key-name', 'key-name']);
    expect(hits[0]?.reason).toContain('mcpServers.acme.env.ACME_TOKEN');
  });

  it('uzasadnienie jest po polsku i nigdy nie zawiera wartosci', () => {
    const secrets = [OPENAI_LIKE, GITHUB_LIKE, AWS_LIKE, RANDOM_TOKEN];
    const text = secrets.map((s, i) => `api_key: ${s}\nlinia ${i} ${s}`).join('\n');
    const hits = [...scan('SKILL.md', text), ...scan('auth.json', text)];
    expect(hits.length).toBeGreaterThan(4);
    const serialized = JSON.stringify(hits);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    for (const hit of hits) expect(hit.reason).toMatch(/[a-zęóąśłżźćń]/i);
  });
});

describe('klasyfikator sekretow: kolumna negatywna (ma przepuscic)', () => {
  it('skill mowiacy o tokenach i hasLach w tresci nie jest trafieniem', () => {
    const prose = [
      '# Logowanie',
      'Uzyj access token zwroconego przez endpoint logowania.',
      'Nigdy nie wpisuj hasla ani API key do repozytorium.',
      'Sekret trzymaj w menedzerze sekretow, a token odswiezaj co godzine.',
      'Parametr max_tokens: 4096 ogranicza dlugosc odpowiedzi.',
      'token: wymagany',
      'password: <twoje-haslo>',
      'api_key: ${ACME_API_KEY}',
      'secret: process.env.ACME_SECRET',
      'Szczegoly w https://example.com/docs/authentication/tokens',
    ].join('\n');
    expect(scan('SKILL.md', prose)).toEqual([]);
  });

  it('nazwa pliku ze slowem key w innym znaczeniu nie jest trafieniem', () => {
    for (const name of [
      'keyboard.md',
      'monkey.ts',
      'key-bindings.md',
      'turkey/SKILL.md',
      'credentials-guide.md',
      '.env.example',
      'docs/keys.md',
    ]) {
      expect(scan(name, 'Skroty klawiszowe.\n'), name).toEqual([]);
    }
  });

  it('hash gita, suma sha256 i dlugi slug nie sa wysoka entropia', () => {
    const gitHash = 'a94f5374fce5edbc8e2a8697c15331677e6ebf0b';
    const sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const slug = 'acme-review-security-checklist-for-the-release-process';
    const text = `commit ${gitHash}\nsha ${sha256}\nskill ${slug}\nsha512-${filler(60, 2)}`;
    expect(scan('notes.md', text)).toEqual([]);
  });

  it('certyfikat publiczny i plik binarny z zerami nie sa trafieniem tresci', () => {
    expect(scan('cert.md', `${PEM_CERT}\nMIIB...\n`)).toEqual([]);
    const binary = new Uint8Array([0, 1, 2, 3, ...bytes(`api_key: ${filler(20)}`)]);
    expect(classifySecrets([{ relPath: 'logo.png', bytes: binary }])).toEqual([]);
  });

  it('wartosci strukturalne bez sekretu przechodza', () => {
    expect(
      classifyStructured('server.json', [
        {
          path: 'env',
          value: { LOG_LEVEL: 'debug', ACME_TOKEN: '${ACME_TOKEN}', max_tokens: 4096 },
        },
      ]),
    ).toEqual([]);
  });

  it('ogranicza liczbe trafien w jednym pliku', () => {
    const text = Array.from({ length: 200 }, (_, i) => `api_key: ${filler(20, i + 1)}`).join('\n');
    expect(scan('config.txt', text).length).toBeLessThanOrEqual(25);
  });
});
