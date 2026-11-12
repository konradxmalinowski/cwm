import { escapeControlChars, MAX_ERRORS, type ValidationError } from './errors';
import { FORBIDDEN_KEYS } from './safe-keys';

/** Manifest jest niezaufanym wejsciem, wiec listy i teksty maja gorny limit. */
export const MAX_LIST_ITEMS = 500;
export const MAX_STRING_LENGTH = 512;

export type PlainObject = Readonly<Record<string, unknown>>;

export function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Czyta tylko wlasne pola, zeby `constructor` czy `toString` nie wygladaly na dane. */
export function field(obj: PlainObject, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

const MAX_PATH_KEY = 64;

/**
 * Klucze pochodza z niezaufanego dokumentu, wiec w sciezce bledu sa przyciete, a znaki sterujace
 * i formatujace zapisane jako `\xNN` (sciezka trafia na terminal).
 */
export function childPath(base: string, key: string): string {
  const cut = key.length > MAX_PATH_KEY ? `${key.slice(0, MAX_PATH_KEY)}...` : key;
  const safe = escapeControlChars(cut);
  return base === '$' ? safe : `${base}.${safe}`;
}

/** Znaki sterujace (Cc) i formatujace (Cf: RLO, zero-width), ktore moga ukryc tresc przed czlowiekiem. */
export const CONTROL_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const SECRET_QUERY_NAME = /token|key|secret|password|auth/i;

function isUnsafeSegment(segment: string): boolean {
  return (
    segment === '' || /[. ]$/.test(segment) || WINDOWS_DEVICE.test(segment) || segment.includes(':')
  );
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/** Zbiera bledy zamiast rzucac, zeby uzytkownik zobaczyl wszystkie naraz. */
export class Checker {
  readonly errors: ValidationError[] = [];

  private readonly paths = new Set<string>();

  /**
   * Jeden blad na pole: pierwszy wygrywa. Po `MAX_ERRORS + 1` bledach przestaje zbierac, wiec
   * walidacja niezaufanego dokumentu konczy sie szybko, a lista nie rosnie bez granic.
   */
  add(path: string, message: string): void {
    if (this.errors.length > MAX_ERRORS || this.paths.has(path)) return;
    this.paths.add(path);
    this.errors.push({ path, message });
  }

  object(
    value: unknown,
    path: string,
    allowed: readonly string[],
    required: readonly string[] = [],
  ): PlainObject | null {
    if (!isPlainObject(value)) {
      this.add(path, 'Oczekiwano obiektu.');
      return null;
    }
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) this.add(childPath(path, key), 'Zabroniony klucz.');
      else if (!allowed.includes(key)) this.add(childPath(path, key), 'Nieznane pole.');
    }
    for (const key of required) {
      if (!Object.hasOwn(value, key)) this.add(childPath(path, key), 'Pole jest wymagane.');
    }
    return value;
  }

  string(value: unknown, path: string, pattern?: RegExp, format?: string): string | null {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > MAX_STRING_LENGTH ||
      CONTROL_CHARS.test(value)
    ) {
      this.add(
        path,
        `Oczekiwano niepustego tekstu (do ${MAX_STRING_LENGTH} znakow, bez znakow sterujacych).`,
      );
      return null;
    }
    if (pattern && !pattern.test(value)) {
      this.add(path, `Wartosc ma zly format${format ? `, oczekiwano: ${format}` : ''}.`);
      return null;
    }
    return value;
  }

  boolean(value: unknown, path: string): boolean | null {
    if (typeof value === 'boolean') return value;
    this.add(path, 'Oczekiwano wartosci true lub false.');
    return null;
  }

  integer(value: unknown, path: string, min: number, max: number): number | null {
    if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) {
      return value;
    }
    this.add(path, `Oczekiwano liczby calkowitej od ${min} do ${max}.`);
    return null;
  }

  oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T | null {
    const match = allowed.find((candidate) => candidate === value);
    if (match !== undefined) return match;
    this.add(path, `Oczekiwano jednego z: ${allowed.join(', ')}.`);
    return null;
  }

  /**
   * Sciezka wzgledna wewnatrz katalogu zasobu. Wiodace `./` jest dozwolone (tak pisza manifesty),
   * reszta musi byc czysta: bez pustych segmentow, `.`, `..`, `:`, `%`, `\`, konca na kropke lub
   * spacje, nazw urzadzen Windows i z normalizacja NFC.
   */
  relativePath(value: unknown, path: string): string | null {
    const text = this.string(value, path);
    if (text === null) return null;
    const body = text.startsWith('./') ? text.slice(2) : text;
    const unsafe =
      text !== text.normalize('NFC') ||
      text.includes('%') ||
      text.includes('\\') ||
      body.split('/').some(isUnsafeSegment);
    if (unsafe) {
      this.add(
        path,
        'Sciezka ma byc wzgledna, bez znakow specjalnych i nie moze wychodzic poza katalog zasobu.',
      );
      return null;
    }
    return text;
  }

  /**
   * Adres https albo http tylko dla petli zwrotnej, bez danych logowania i bez parametrow
   * zapytania o nazwie sugerujacej sekret. Komunikaty nie przytaczaja adresu.
   */
  url(value: unknown, path: string): string | null {
    const text = this.string(value, path);
    if (text === null) return null;
    let parsed: URL;
    try {
      parsed = new URL(text);
    } catch {
      this.add(path, 'Adres URL jest nieprawidlowy.');
      return null;
    }
    const secure =
      parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopback(parsed.hostname));
    if (!secure) {
      this.add(path, 'Adres ma uzywac https (http tylko dla localhost, 127.0.0.0/8 i ::1).');
    } else if (parsed.username !== '' || parsed.password !== '') {
      this.add(path, 'Adres nie moze zawierac nazwy uzytkownika ani hasla.');
    } else if ([...parsed.searchParams.keys()].some((name) => SECRET_QUERY_NAME.test(name))) {
      this.add(path, 'Adres nie moze przekazywac sekretow w parametrach zapytania.');
    } else {
      return text;
    }
    return null;
  }

  /** Warunek na wartosc, ktora juz jest poprawnym polem (np. wersja): sprawdza tylko, gdy jest. */
  literal(value: unknown, path: string, expected: string): void {
    if (value !== undefined && value !== expected) this.add(path, `Oczekiwano "${expected}".`);
  }

  /** Brak listy oznacza pusta. Powtorzenia (po `keyOf`) sa bledem. */
  list<T>(
    value: unknown,
    path: string,
    item: (element: unknown, elementPath: string) => T | null,
    keyOf: (item: T) => string = String,
  ): T[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      this.add(path, 'Oczekiwano listy.');
      return [];
    }
    if (value.length > MAX_LIST_ITEMS) {
      this.add(path, `Lista moze miec najwyzej ${MAX_LIST_ITEMS} elementow.`);
      return [];
    }
    const seen = new Set<string>();
    const result: T[] = [];
    value.forEach((element: unknown, index) => {
      const elementPath = `${path}[${index}]`;
      const parsed = item(element, elementPath);
      if (parsed === null) return;
      const key = keyOf(parsed);
      if (seen.has(key)) this.add(elementPath, 'Powtorzony element.');
      else {
        seen.add(key);
        result.push(parsed);
      }
    });
    return result;
  }
}
