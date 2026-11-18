# ADR 0058: import z repozytorium Git jako źródła skilli

Status: zaakceptowane
Data: 2026-11-18
Dotyczy: ADR 0008 (blokada sieci), ADR 0019 (Git jako warstwa opcjonalna), ADR 0022 (czytnik źródła), ADR 0048 (pluginy z git), ADR 0057 (historia importu)

## Kontekst

Kreator importu czyta wyłącznie lokalne katalogi narzędzi (`~/.claude`, `~/.codex`, `~/.gemini`).
Skille i agenci krążą jednak jako repozytoria: żeby wziąć jeden z nich, użytkownik klonował
repozytorium ręcznie i kopiował pliki. Pozycja "Import z repozytorium Git jako źródła skilli" czekała
w backlogu, bo wymaga pełnej ścieżki traktowania treści jako niezaufanej: zawartość repozytorium
pochodzi z sieci i nikt jej nie przejrzał.

CLI ma już całe pobieranie: `cwm plugin add git|fetch|update` (ADR 0048) uruchamia `git` po ścieżce
bezwzględnej, ze środowiskiem od zera, z opcjami bez hooków, protokołów `file` i `ext`, submodułów
i LFS, z płytkim pobraniem, limitami czasu, liczby plików i rozmiaru oraz weryfikacją kopii względem
skrótu commita. Straż sieci (`denyNetwork`) pilnuje, żeby `start`, `diff` i `sync` do niej nie sięgały.

## Rozważane opcje

**Własna implementacja pobierania w main.** Odrzucone: dwa miejsca z procesem `git` i siecią to dwa
miejsca do utrzymania hartowania, a każda rozbieżność jest luką.

**Pobieranie w rendererze.** Niemożliwe i niepożądane: CSP ma `connect-src 'none'`, a renderer nie
ma dostępu do procesów (ADR 0008).

**Lokalna ścieżka repozytorium zamiast adresu.** Odrzucone: wymagałaby protokołu `file`, który
hartowanie wyłącza, albo kanału wyboru katalogu. Katalog, który użytkownik już ma na dysku, można
zaimportować z lokalizacji narzędzi, a repozytorium sklonowane obok nie jest źródłem, któremu aplikacja
ufa bardziej niż adresowi.

**Ponowne użycie `fetchGitSource` z osobnym katalogiem roboczym.** Wybrane.

## Decyzja

Kreator importu dostaje drugie źródło: "Z repozytorium Git", adres https i opcjonalny ref.

1. **Pobieranie to ten sam kod co w CLI.** `infra/git-import/git-import-source.ts` woła
   `fetchGitSource` z układem (`CwmLayout`) zakorzenionym w `<userData>/git-import` zamiast w `~/.cwm`.
   Dzięki temu bez kopiowania działają: hartowanie procesu, limity (500 plików, 1 MiB na plik, 10 MiB
   razem, 300 s), odmowa dowiązań symbolicznych w commicie, odmowa składnika `.git` i znaków
   sterujących w ścieżkach, łańcuch skrótów od commita, straż sieci i sprzątanie `.tmp-*`.
   Jedyna zmiana w `git-fetch.ts` to pole `kind` w odmowie, żeby main mógł odróżnić brak `git`,
   awarię procesu i odrzucenie treści.
2. **Katalog roboczy.** `<userData>/git-import`, tryb 0700 na POSIX, tylko na czas jednego skanu. Przed
   pobraniem, po skanie (także po błędzie) i przy starcie aplikacji `sources/` w tym katalogu jest
   usuwane. Kopia istnieje więc tylko wtedy, gdy trwa skan; kandydaci zostają w pamięci, a `import:apply`
   nie czyta dysku. Brak `git` w PATH (albo system, na którym CWM go nie obsługuje, czyli Windows)
   daje czytelny komunikat, a reszta aplikacji działa bez zmian.
3. **Granice w kodzie.** `git-fetch.ts` miał jednego importera (`cli/commands/plugin.ts`). Drugim jest
   `git-import-source.ts`: reguła lintu, lista plików w sondach `scripts/verify-boundaries.mjs` i skan
   źródeł znają oba. Pozostałe moduły, w tym `main/`, nadal nie mają do `git-fetch.ts` drogi, a proba
   "main/ importuje git-fetch" nadal musi paść. Port `core/ports/git-source.ts` jest jedyną rzeczą,
   którą widzi `ImportService`.
4. **Skan to ten sam skan.** `ImportService.scanGit` otwiera źródło przez port i wywołuje wspólną
   ścieżkę z `scan`: te same adaptery, ten sam klasyfikator sekretów, te same statusy i bramki w `apply`.
   Czytnik to `FsSourceReader`, który odmawia wyjścia poza korzeń, a dowiązań w kopii i tak nie ma
   (commit z dowiązaniem jest odrzucany w całości przy pobraniu).
5. **Rozpoznawany układ** (w kolejności pierwszeństwa przy duplikatach): `skills/`, `.claude/skills|agents|commands`,
   `.codex/skills|agents`, `.gemini/skills|agents|commands` oraz pojedynczy `SKILL.md` w korzeniu
   (nazwą elementu jest nazwa repozytorium; `SingleSkillReader` pokazuje korzeń jako katalog skilli
   z jednym podkatalogiem bez kopiowania plików). Z repozytorium nie wchodzą instrukcje globalne,
   hooki ani rejestr agentów Codeksa: to pliki, które po eksporcie zmieniają zachowanie narzędzia
   bez wiedzy użytkownika, więc przychodzą tylko z jego własnych katalogów. `skills/` w korzeniu skanuje
   adapter Claude Code. Brak znanego układu to pusty podgląd z wyjaśnieniem, nie błąd.
6. **Pochodzenie.** `ImportOrigin` dostaje opcjonalne `git: { url, commit, ref }`. Adres jest bez danych
   logowania, zapytania i fragmentu (kontrolę robi `gitUrlProblem` przy wejściu, a `validate.ts` przy
   odczycie `item.json`, więc hasło wpisane w adres nie zostaje na dysku). Wpisy `create` i `update`
   w historii niosą notatkę `git=<adres>@<commit>`, a Historia pokazuje "z repozytorium X@sha" (12 znaków).
   Ścieżka kopii nie jest zapisywana nigdzie.
7. **IPC.** Nowy kanał `import:scan-git` `{ url, ref? }` zwraca `ImportScanDto` z polem `git`
   (adres, ref, commit, liczba submoduli). Main waliduje wejście tym samym kodem co renderer
   (`core/services/import/git-input.ts`): długość do 2048, tylko `https` (bez `http`, nawet na pętli
   zwrotnej), brak nazwy użytkownika, hasła, zapytania i fragmentu, forma kanoniczna; ref do 128 znaków,
   nazwa gałęzi, taga albo pełny SHA. Komunikaty nie przytaczają adresu. Kanał nie zapisuje do biblioteki,
   więc nie jest pod blokadą zapisu; jedno pobieranie naraz (`git-busy`). Renderer nie dostaje
   ścieżek, a komunikaty z procesu `git` (stderr serwera, ścieżka katalogu roboczego) zastępuje komunikat stały.
8. **Sieć w aplikacji.** Zapis w ADR 0008 ("brak połączeń wychodzących") dotyczy renderera i zostaje:
   CSP i `session.webRequest` blokują go jak dotąd. Proces `git` startuje w main wyłącznie po kliknięciu
   "Pobierz i przeskanuj" i nigdy w tle. README, ARCHITECTURE i OGRANICZENIA mówią o tym wprost.
9. **Interfejs.** Sekcja pod listą lokalizacji w kroku 1: pola "Adres repozytorium" i "Ref", przycisk
   "Pobierz i przeskanuj" (zawsze aktywny; pusty adres daje błąd przy polu i fokus na nim). Dalej ten
   sam podgląd, z linią o źródle (adres, ref, commit) i ostrzeżeniem o submodułach, które nie są pobierane.

10. **Pola wykonawcze w elementach z repozytorium.** Frontmatter agenta, komendy albo skilla może deklarować
    `hooks`, `mcpServers`, `permissionMode` oraz listy narzędzi (`tools`, `allowed-tools`). Eksportery
    (Claude Code, Codex, Gemini CLI) odtwarzają bajty pliku źródła, gdy element wraca do narzędzia, z którego
    przyszedł, a przy eksporcie do innego narzędzia tylko wymieniają utracone klucze w ostrzeżeniu. Pole
    zadeklarowane w cudzym repozytorium wróciłoby więc do narzędzia i tam zostało uruchomione. Wycinanie przy
    eksporcie dotykałoby trzech eksporterów i każdego rodzaju elementu, więc zdecydowano inaczej: **przy
    imporcie** (`core/services/import/git-risk.ts`, tylko dla źródła Git).
    - `hooks`, `mcpServers` i `permissionMode` (także `mcp_servers`, `permission_mode`) są usuwane z
      frontmattera pliku źródła w snapshocie oraz z `unmappedKeys`. Treść i reszta pól zostają bez zmian.
      Frontmatter, w którym po wycięciu nadal widać taki klucz (inna składnia YAML), jest pomijany w całości.
    - `tools`, `allowed-tools`, `allowedTools`, `disallowedTools` zostają, a element dostaje ostrzeżenie, że
      po eksporcie narzędzie będzie mogło z nich korzystać.
    - Plik TOML (agent Codeksa, komenda Gemini CLI) z `mcp_servers`, `hooks`, `permissionMode`,
      `approval_policy` albo `sandbox_mode` innym niż `read-only` jest pomijany z powodem: klucza nie da się
      wyciąć z TOML bez ruszania reszty.
    - Wycięte pola są w ostrzeżeniu przy elemencie i w notatce wpisu Historii (`usunieto=...`; Historia
      pokazuje "usunięto pola wykonawcze: ..."). Użytkownik może je dopisać ręcznie w edytorze elementu w
      bibliotece: wtedy jest to jego decyzja.
    - Nic z repozytorium nie jest zaznaczone z góry, także elementy `new` bez sekretów.
11. **Adres: https i publiczny host.** `open()` i `ImportService.scanGit` same wymagają https, niezależnie od
    kontroli w IPC. Wyjątek dla `http` na pętli zwrotnej istnieje tylko za opcją wstrzykiwaną w testach
    (`allowLoopbackHttpForTests`), nigdy domyślnie. `gitUrlInputProblem` odrzuca literały IP (v4 i v6),
    `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.home.arpa` i nazwy bez kropki. Nazwa DNS, która
    rozwiązuje się na adres prywatny, nadal przechodzi: aplikacja nie rozwiązuje nazw przed pobraniem, więc
    to nie jest ochrona przed SSRF, tylko odrzucenie oczywistych adresów lokalnych (jak w ADR 0048 adres
    https jest zaufany tak jak pole wpisane przez użytkownika).
12. **Sprzątanie i zamykanie.** Sprzątanie z chwili startu jest zapamiętane, a `open()` czeka na nie.
    `purge()` i `open()` ustawiają tryb 0700 na katalogu roboczym. `before-quit` zabija grupy procesów
    trwających poleceń `git` (`abortRunningGit`); nasłuchiwacze sygnałów procesu, które rejestruje `runGit`,
    są zdejmowane po zakończeniu każdego polecenia. Przerwanie z poziomu kreatora (AbortSignal) zostaje poza
    zakresem.
13. **Kolizje wielkości liter.** Lista plików commita z dwiema ścieżkami różniącymi się tylko wielkością liter
    albo postacią Unicode (`SKILL.md` i `skill.md`) jest odrzucana jawnie w `checkGitTreeListing`, przed
    zapisem czegokolwiek (to samo dotyczy `cwm plugin add git`). Wcześniej chroniła przed tym dopiero
    weryfikacja `verifyGitCopy`, bez testu.

## Konsekwencje

Użytkownik przyjmuje skille z publicznego repozytorium w kilku kliknięciach, a każdy element niesie
adres i commit, z którego pochodzi. Import niczego nie uruchamia, a treść przechodzi tę samą kontrolę
sekretów i ten sam podgląd co import lokalny. Komendy i agenci zaczynają działać w narzędziu dopiero po
eksporcie, dlatego nic nie jest zaznaczone z góry, pola wykonawcze są usuwane, a listy narzędzi opatrzone
ostrzeżeniem.

Ograniczenia, na które się godzimy:

- Repozytorium z dowiązaniem symbolicznym w dowolnym miejscu jest odrzucane w całości (zachowanie ADR 0048).
  Repozytoria skilli, które łączą katalogi dowiązaniami, trzeba zaimportować inaczej.
- Limity z `TREE_LIMITS` (500 plików, 1 MiB na plik, 10 MiB) dotyczą całego repozytorium, nie jednego skilla;
  duże repozytoria z samymi skillami mogą się nie zmieścić.
- Tylko publiczne repozytoria przez https, bez logowania, SSH i lokalnych ścieżek. Adres, który
  przekierowuje, kończy się błędem pobrania (`http.followRedirects=false`).
- Windows: `git-fetch.ts` zakłada ścieżki POSIX w PATH, więc na Windowsie funkcja kończy się komunikatem
  o braku `git`. To samo ograniczenie ma CLI.
- Anulowanie skanu odrzuca wynik, ale pobieranie w main dokańcza się (do 5 minut); w tym czasie kolejne
  pobranie dostaje `git-busy`.
- Narzędzie w etykiecie elementu to adapter, który skanował katalog (Claude Code dla `skills/` i `SKILL.md`
  w korzeniu), a nie narzędzie autora repozytorium.
- Przypięcie SHA-1 i brak weryfikacji podpisów commitów: te same granice co w ADR 0048.
- Usuwanie pól działa na górnym poziomie frontmattera. Treść skilla, agenta i komendy to nadal instrukcja
  dla modelu, a polecenia w ciele komendy (np. wstawki powłoki) importer nie analizuje.
- Zawartość skilla pozostaje cudzym tekstem. Kontrola sekretów jest heurystyką, a import niczego
  nie uruchamia, ale eksport do narzędzia robi z tej treści instrukcję dla modelu: decyzja "zaufaj temu
  repozytorium" należy do użytkownika, który zaznacza element w podglądzie.
