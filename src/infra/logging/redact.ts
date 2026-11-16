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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Male litery w kodach procentowych: `%2f` i `%2F` to ten sam znak. */
function lowerPercent(value: string): string {
  return value.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
}

/**
 * Zamienia katalog domowy na `~` w dowolnym miejscu tekstu (komunikat bledu, linia logu).
 * `redactHomePath` dziala tylko na poczatku wartosci, a log niesie sciezki w srodku zdania.
 *
 * Rozpoznaje zapis z `/`, z `\`, z podwojonym `\\` (JSON) i zakodowany procentowo. Po nazwie
 * konta musi byc granica (`/Users/janusz` nie jest katalogiem `/Users/jan`), a przed nia nie moze
 * stac litera, cyfra ani kropka (`/srv/home/acme` to inny katalog). Na Windowsie i macOS
 * porownanie nie rozroznia wielkosci liter.
 */
export function redactHomeInText(
  text: string,
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const home = homeDir.replace(/[\\/]+$/, '');
  if (home.length === 0) return text;
  const forward = home.replaceAll('\\', '/');
  const back = home.replaceAll('/', '\\');
  const encoded = [encodeURI(forward), encodeURIComponent(forward), encodeURIComponent(back)];
  const variants = new Set([
    home,
    forward,
    back,
    back.replaceAll('\\', '\\\\'),
    ...encoded,
    ...encoded.map(lowerPercent),
  ]);
  const alternatives = [...variants]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  const flags = platform === 'win32' || platform === 'darwin' ? 'giu' : 'gu';
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_.~-])(?:${alternatives})(?![\\p{L}\\p{N}_-])`,
    flags,
  );
  return text.replace(pattern, '~');
}
