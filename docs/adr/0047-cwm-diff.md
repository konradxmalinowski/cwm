# ADR 0047: `cwm diff` (co zmieni najbliższy `cwm start`)

Status: zaakceptowane w zakresie planu (2026-11-15)
Data: 2026-11-15
Dotyczy: ADR 0040 (profil, manifest generowania, `cwm start`), ADR 0044 (pakiety i zgoda), ADR 0045 (`cwm sync`)
Źródło: plan `plans/2026-11-15-cwm-diff.md` (lokalny, poza repozytorium); kod w `src/cli/commands/diff.ts`, `src/infra/cwm/runtime-diff.ts`, `src/core/cwm/line-diff.ts`; opis użytkowy w `docs/CLI.md`

## Kontekst

`cwm start --dry-run` pokazuje plan (zatwierdzenia, listę plików, argumenty silnika), ale nie mówi, co
zmieni się względem profilu, który już leży w `~/.cwm/runtime/<firma>/`. Po `cwm sync`, po zmianie
manifestu albo po edycji zasobu w rejestrze użytkownik chce zobaczyć różnicę przed startem, bez
ryzyka, że sprawdzanie samo coś zapisze albo zablokuje działającą sesję.

Uzupełnienie (ADR 0051): `cwm diff` uruchamia dodatkowo `claude --version` (w katalogu tymczasowym systemu, z limitem
czasu, błąd to `null`), żeby ocenić lockfile projektu; to jedyny proces, jaki uruchamia.

## Decyzje

1. **Ten sam plan co start.** `cwm diff` woła `prepareRun` i `loadApprovalState`, wydzielone z
   `startCommand` do `src/cli/commands/start.ts`, więc plan (`buildRuntimePlan`), zatwierdzenia
   i oceny pakietów powstają dokładnie tym samym kodem. Nie ma drugiej ścieżki budowania planu.
2. **Tylko odczyt.** Różnica jest liczona w `src/infra/cwm/runtime-diff.ts` z planu w pamięci,
   manifestu (`loadGenerationManifest`) i plików profilu czytanych przez `readRuntimeFile` (te same
   kontrole dowiązań, właściciela i ścieżek co przy zapisie). Katalog firmy jest otwierany przez
   `peekRuntimeRoot` (nie powstaje), znaczniki sesji przez `liveSessions(root, false)` (bez
   sprzątania martwych). Nie ma mutexa `.lock`, więc działające sesje i równoległy `cwm start`
   nie są blokowane, a `cwm diff` nie czeka na zamek. Silnik nie jest uruchamiany (bez
   `claude --version`).
3. **Decyzje `applyPlan` odtworzone, nie skopiowane.** Które pliki są dodane, zmienione, usunięte
   albo zostają, wynika z tych samych reguł co zapis: plik planu o innym skrócie niż na dysku, plik
   w manifeście poza planem w obszarach sprzątanych, plik na dysku bez wpisu w manifeście i bez prawa
   do nadpisania (odmowa). Wspólne części wyniesiono do `runtime-apply.ts` (`cleanupAreas`,
   `expectedMode`, `changedKeys`), więc `applyPlan` i `cwm diff` liczą obszary sprzątania jedną funkcją.
4. **Dryf.** Plik z planu, którego skrót na dysku różni się od wpisu w manifeście (albo nie ma
   wpisu, np. `settings.json` dopisany przez silnik), jest w osobnej grupie „zmienione poza CWM” z
   informacją, że start go nadpisze i zachowa kopię w `generated/prev`. Plik z manifestu zmieniony
   poza CWM, którego plan już nie zawiera, trafia na listę „zostają na miejscu” i nie liczy się jako
   zmiana (start go nie usunie).
5. **Co widać z treści.** Ujednolicony diff (3 wiersze kontekstu) dla zmienionych plików
   tekstowych, w których po obu stronach jest najwyżej 200 wierszy; dłuższe dostają tylko liczniki `+N -M` (przy bardzo dużej liczbie zmian
   przybliżone). Dla plików dodanych i usuniętych: ścieżka, rozmiar, skrót.
   Pliki binarne i większe niż 512 KiB: bez treści. **Pliki z możliwym sekretem** (nazwa albo
   treść przez `classifyFileName` i `classifyStrict`, te same reguły co import) nie mają ani
   wierszy, ani liczników. W plikach JSON (`settings.json` profilu i uruchomienia, `mcp.json`)
   zawartość każdego klucza `env` jest zastępowana znacznikiem przed porównaniem i przed klasyfikatorem;
   zmiana `env` jest zgłaszana tylko słowami („env zmieniony (treść ukryta)”), z porównania
   kanonicznego zapisu wartości.
6. **Pluginy jako jeden wpis.** Migawki `plugins/<id>@<skrót>/` są zwijane do wpisu na plugin: nowy,
   zmieniony (stara i nowa migawka tego samego id, z liczbą dodanych, zmienionych i usuniętych plików)
   albo usuwany. Migawki używane przez trwającą sesję nie są sprzątane przez start, więc nie są
   zmianą.
7. **Pliki uruchomienia.** `sessions/<projekt>/settings.json`, `mcp.json` i `plugin/` porównujemy z
   tym, co zostało po ostatniej sesji tego projektu (stan na dysku); brak ostatniej sesji to „dodane”.
8. **Zatwierdzenia.** Krótko: ile zasobów czeka na zgodę i które pakiety wymagają ponownej zgody
   (z liczbą zasobów). To informacja, nie wpływa na kod wyjścia.
9. **Kody wyjścia.** `0`: profil zgadza się z planem. `1`: start coś zmieni (jest dodany, zmieniony,
   usunięty plik albo migawka pluginu) albo odmówi zapisu (plik spoza CWM w miejscu pliku planu,
   niebezpieczny plik, trwająca sesja firmy z innym profilem). `2`: każdy błąd użycia i ustawienia
   (brak manifestu projektu, uszkodzony manifest firmy, zła opcja). Odwrotnie niż w `start`, błędy
   wczytania mają kod `2`, żeby `1` znaczyło tylko „jest różnica”.
10. **Formaty.** Tekst czytelny z grupami (dodane, zmienione, zmienione poza CWM, usunięte, pluginy,
    zostają na miejscu, powody odmowy), `--stat` (liczniki bez wierszy diffu) i globalne `--json`
    (`{ ok, differs, company, project, profile, approvals, files[], plugins[], kept[], unchanged,
    blockers[], warnings[] }`; przy `--stat` pole `hunks` jest `null`). Teksty z dysku przechodzą przez
    `safeText` jak w reszcie CLI.

## Konsekwencje i ryzyko szczątkowe

- Wynik jest zdjęciem stanu: między `cwm diff` a `cwm start` rejestr, profil albo sesje mogą się
  zmienić. Start liczy plan od nowa i pod blokadą.
- `generated/manifest.json` (znacznik czasu), `.lock`, `active/` i `tmp/` nie są częścią porównania:
  start zapisuje manifest przy każdym uruchomieniu, co nie liczy się jako zmiana profilu.
- Odczyt bez blokady może trafić na równoległy `cwm start` w połowie zapisu profilu: zapisy plik po
  pliku są atomowe, więc każdy plik jest w całości stary albo nowy, ale zestaw plików może być
  mieszany. Wynik jest wtedy przybliżeniem; powtórz polecenie.
- Wyklucza się sekret rozpoznawalny klasyfikatorem; wartość, której klasyfikator nie rozpozna, a która
  leży poza `env` w pliku zmienionym i krótkim (do 200 wierszy), pokaże się w diffie. Zasoby z
  rejestru przeszły ten sam klasyfikator przy imporcie.
- Zmiana samych zatwierdzeń nie jest „zmianą startu” w kodzie wyjścia, choć start je zapisze.
