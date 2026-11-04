/** Pole tekstowe pochlania skroty `j`, `k` i `/`: w nim wpisujemy znaki, nie nawigujemy. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
    return true;
  return (
    target.tagName === 'INPUT' && !['checkbox', 'radio'].includes((target as HTMLInputElement).type)
  );
}

/**
 * `j` i `k` przesuwaja fokus po elementach pasujacych do `selector`, `/` przenosi go do pola
 * wyszukiwania (DESIGN.md, Klawiatura). Zwraca true, gdy obsluzyl zdarzenie. Nie dziala,
 * gdy otwarte jest okno dialogowe albo uzytkownik wpisuje tekst.
 */
export function handleRowNavKey(event: KeyboardEvent, selector: string, searchId: string): boolean {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return false;
  if (document.querySelector('dialog[open]') !== null) return false;
  if (isTextEntry(event.target)) return false;

  if (event.key === '/') {
    const search = document.getElementById(searchId);
    if (search === null) return false;
    event.preventDefault();
    search.focus();
    return true;
  }
  if (event.key !== 'j' && event.key !== 'k') return false;

  const rows = Array.from(document.querySelectorAll<HTMLElement>(selector));
  if (rows.length === 0) return false;
  event.preventDefault();
  const current = rows.indexOf(document.activeElement as HTMLElement);
  const step = event.key === 'j' ? 1 : -1;
  const next =
    current === -1
      ? step === 1
        ? 0
        : rows.length - 1
      : Math.min(rows.length - 1, Math.max(0, current + step));
  rows[next]?.focus();
  return true;
}
