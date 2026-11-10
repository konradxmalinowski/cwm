/**
 * Zapamietuje element, ktory ma fokus w chwili otwarcia okna dialogowego, i zwraca funkcje,
 * ktora oddaje mu fokus po zdjeciu okna z drzewa.
 *
 * Fokus oddawany z `setTimeout` w rodzicu zaraz po `close` jest wyscigiem: gdy zmiana
 * wykrywania zmian dojdzie po nim, element jest jeszcze nieaktywny (modalny dialog blokuje
 * reszte strony), `focus()` nic nie robi i fokus laduje na `body`. Tu fokus wraca dopiero po
 * zniszczeniu komponentu, czyli po `close()`, wiec nie zalezy od tempa wykonania.
 * Gdy element nie istnieje (np. usunieto element, ktory okno dotyczylo) albo otworzyl sie
 * kolejny dialog, nic sie nie dzieje.
 */
export function rememberOpener(): () => void {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  return () => {
    setTimeout(() => {
      if (opener === null || !opener.isConnected) return;
      if (document.querySelector('dialog[open]') !== null) return;
      if (opener instanceof HTMLButtonElement && opener.disabled) return;
      opener.focus();
    }, 0);
  };
}
