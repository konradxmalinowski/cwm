/**
 * Redakcja sciezek przed oddaniem ich poza proces glowny. Katalog domowy
 * zamieniamy na `~`, bo zawiera nazwe konta uzytkownika, a raport
 * diagnostyczny ma dac sie wkleic do zgloszenia bledu (ADR 0004).
 */
export function redactHomePath(value: string, homeDir: string): string {
  if (homeDir.length === 0) return value;
  const normalizedHome = homeDir.replace(/[\\/]+$/, '');
  if (normalizedHome.length === 0) return value;
  if (value === normalizedHome) return '~';
  const withSeparator = `${normalizedHome}${value.includes('\\') ? '\\' : '/'}`;
  if (value.startsWith(withSeparator)) {
    return `~${value.slice(normalizedHome.length)}`;
  }
  if (value.startsWith(normalizedHome)) {
    return `~${value.slice(normalizedHome.length)}`;
  }
  return value;
}

/**
 * Zamienia katalog domowy na `~` w dowolnym miejscu tekstu (komunikat bledu, linia logu).
 * `redactHomePath` dziala tylko na poczatku wartosci, a log niesie sciezki w srodku zdania.
 */
export function redactHomeInText(text: string, homeDir: string): string {
  const home = homeDir.replace(/[\\/]+$/, '');
  if (home.length === 0) return text;
  const variants = new Set([home, home.replaceAll('\\', '/'), home.replaceAll('/', '\\')]);
  let out = text;
  for (const variant of variants) out = out.replaceAll(variant, '~');
  return out;
}
