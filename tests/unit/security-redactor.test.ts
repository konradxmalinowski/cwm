import { describe, expect, it } from 'vitest';

import { redactSecrets } from '../../src/core/services/security/secret-redactor';
import { redactHomeInText } from '../../src/infra/logging/redact';
import { SECRETS, filler } from './security-secrets';

describe('redactSecrets', () => {
  it('zamienia znany klucz na znacznik i zostawia reszte linii', () => {
    const r = redactSecrets(`url = "https://acme.test"\nkey: ${SECRETS.openai} # komentarz\n`);
    expect(r.text).toContain('key: [ukryty sekret: known-key] # komentarz');
    expect(r.text).toContain('url = "https://acme.test"');
    expect(r.text).not.toContain(SECRETS.openai);
    expect(r.rules).toContain('known-key');
  });

  it('redaguje wartosc przypisana do klucza o nazwie wskazujacej na sekret', () => {
    const value = `${filler(10)}7${filler(10, 3)}`;
    const r = redactSecrets(`{ "ACME_API_KEY": "${value}", "ACME_NAME": "acme" }`);
    expect(r.text).not.toContain(value);
    expect(r.text).toContain('"ACME_NAME": "acme"');
    expect(r.rules).toContain('key-name');
  });

  it('redaguje dlugi ciag o wysokiej entropii', () => {
    const token = `${filler(40, 5)}9`;
    const r = redactSecrets(`Authorization przez ${token} koniec`);
    expect(r.text).toBe('Authorization przez [ukryty sekret: entropy] koniec');
  });

  it('redaguje caly blok klucza prywatnego, takze linie srodkowe', () => {
    const body = filler(64, 9);
    const r = redactSecrets(`przed\n${SECRETS.pemBegin}\n${body}\n${SECRETS.pemEnd}\npo\n`);
    expect(r.text).not.toContain(body);
    expect(r.text).not.toContain('PRIVATE KEY');
    expect(r.text.startsWith('przed\n')).toBe(true);
    expect(r.text.endsWith('\npo\n')).toBe(true);
  });

  it('plik o nazwie wskazujacej na dane logowania traci wszystkie wartosci', () => {
    const r = redactSecrets('{\n  "login": "jan",\n  "x": "abc"\n}\n', 'auth.json');
    expect(r.text).not.toContain('jan');
    expect(r.text).not.toContain('abc');
    expect(r.text).toContain('"login": [ukryty sekret: file-name]');
    expect(r.text.startsWith('{\n')).toBe(true);
    const env = redactSecrets('A=1\nB=dwa\n', 'cfg/.env');
    expect(env.text).toBe('A=[ukryty sekret: file-name]\nB=[ukryty sekret: file-name]\n');
  });

  it('zwykly tekst przechodzi bez zmian, z zachowaniem koncow linii', () => {
    const plain = '# Tytul\r\nopis skilla o tokenach i hasle\r\n- punkt\r\n';
    const r = redactSecrets(plain);
    expect(r.text).toBe(plain);
    expect(r.rules).toEqual([]);
  });
});

describe('redactHomeInText', () => {
  it('zamienia katalog domowy w srodku zdania, takze w wariancie z backslashem', () => {
    expect(redactHomeInText('blad w /home/acme/.codex/x i /home/acme', '/home/acme/')).toBe(
      'blad w ~/.codex/x i ~',
    );
    expect(redactHomeInText('C:\\Users\\acme\\a.txt', 'C:\\Users\\acme')).toBe('~\\a.txt');
    expect(redactHomeInText('bez zmian', '')).toBe('bez zmian');
  });
});
