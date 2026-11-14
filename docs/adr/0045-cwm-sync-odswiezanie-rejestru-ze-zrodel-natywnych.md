# ADR 0045: `cwm sync`, odświeżanie rejestru ze źródeł natywnych

Status: zaakceptowane w zakresie decyzji właściciela (2026-11-14)
Data: 2026-11-14
Dotyczy: ADR 0039 (import), ADR 0041 (pliki oznaczone, pochodzenie), ADR 0043 (marketplace), ADR 0044 (pakiety i zgoda)
Źródło: plan `plans/2026-11-14-cwm-sync.md` (lokalny, poza repozytorium); kod w `src/infra/cwm/{sync,resource-lists}.ts`, `src/infra/cwm/{packs,approvals,writer}.ts`, `src/cli/commands/sync.ts`, `src/cli/import-render.ts`; opis użytkowy w `docs/CLI.md`

## Kontekst

Pierwsze prawdziwe użycie pokazało dwie luki. Po edycji pliku w katalogu natywnym (np. agent w
`~/.claude/agents`) trzeba było ręcznie powtórzyć `cwm import` z tym samym `--from` i tymi samymi
`--include-flagged`. Po usunięciu źródła (cały zestaw skilli) zasoby zostawały w rejestrze, w
`config.yaml`, w pakiecie i w zatwierdzeniach, a sprzątanie było ręczne.

## Decyzja

`cwm sync [--source <katalog>] [--dry-run] [--json]` odświeża rejestr z katalogów, z których zasoby
zaimportowano. Pochodzenie już jest w rejestrze: `spec.nativeDir` zasobów `skill`, `agent`, `command`
i `files` (ADR 0041). Nic nie jest dopisywane do manifestów.

1. **Źródła.** Zasoby rejestru są grupowane po (`nativeDir`, przestrzeń nazw: `global` albo firma).
   Dla każdej grupy ten sam przebieg co `cwm import`: `scanClaudeSource`, `buildImportPlan`,
   `buildPackPlan`, a przy zapisie `applyImportPlan` i `applyPackPlan`. Nie ma drugiej kopii tej
   logiki; wspólny kod wyświetlania przeniesiono z `import.ts` do `src/cli/import-render.ts`.
   `Settings` nie ma `nativeDir` (import go nie zapisuje), więc sync go pomija; zostaje
   `cwm import claude`. Skan zwraca też kandydata `settings`, który jest odfiltrowywany.
2. **Pliki oznaczone jako możliwy sekret.** Sync dołącza plik tylko wtedy, gdy zasób już jest w
   rejestrze i plik leży w nim z tym samym skrótem co bajty, które import by dziś zapisał (dla
   rodzaju `files` po przetworzeniu frontmattera). Był więc świadomie dołączony i źródło go nie
   zmieniło. Plik, który się zmienił od dołączenia, wraca do wyboru na terminalu (domyślnie żaden),
   a plan mówi o tym wprost, bo bez dołączenia znika on z zasobu (jego kopia zostaje do następnego
   zapisu albo usunięcia zasobu w `.<nazwa>.old-*`, zob. niżej). Pliki dołączone bez pytania plan
   wypisuje z powodem oznaczenia. Nowe pliki oznaczone: wybór jak w
   imporcie. Twardego sekretu nie da się dołączyć.
3. **Zasoby, których źródło zniknęło.** Zasób z rejestru jest do usunięcia, gdy plan importu go nie
   zawiera, a źródło go nie ma: katalog `nativeDir` nie istnieje albo skan nie zna wpisu. Skan, który
   pominął wpis z raportem (kolizja nazw, trafienie w `SKILL.md`, niepoprawna nazwa), nie oznacza,
   że wpis zniknął, więc taki zasób zostaje; wyjątkiem jest `dowiązanie zerwane`, czyli właśnie
   zniknięcie zestawu skilli. Skan przerwany limitem albo z pominiętym całym obszarem (`skills`,
   `agents`, `commands`) nie usuwa niczego z tego źródła. Obszar, którego nie da się sprawdzić
   albo wylistować (`EACCES`, `EPERM` z TCC macOS) albo który nie jest katalogiem (plik w miejscu
   `skills`), jest zapisywany w raporcie skanu jako `obszar nieczytelny` albo `obszar nie jest
   katalogiem`, a `cwm sync` dodatkowo sprawdza każdy obszar przez `lstat`; w obu przypadkach źródło
   jest niepełne i nic z niego nie jest usuwane. Tylko nieobecny obszar (`ENOENT`) znaczy, że zasoby
   zniknęły.
   Zasób, który nie ma źródła w swojej grupie, ale występuje w planie albo w skanie innej grupy
   (wszystkie grupy są przeglądane, także przy `--source`), zostaje w rejestrze z ostrzeżeniem.
   Zasób zgłoszony przez dwa źródła naraz przestawiałby `nativeDir` tam i z powrotem, więc oba
   źródła są błędem (kod `1`, nic z nich nie jest zapisywane). Skan, który się nie udał (źródło w katalogu
   danych CWM, nie katalog, limit), jest błędem tej grupy: jej zasoby zostają bez zmian, a polecenie
   kończy się kodem `1`.
4. **Zakres usunięcia.** Po zgodzie: wpisy w `resources.mandatory/optional` w `config.yaml`, w
   `resources.enable`, `disableOptional` i `exports` w każdym `company.yaml`, członkostwo w
   pakietach (pusty pakiet znika razem z zaufanymi skrótami), zaufane wpisy pakietów, wpisy
   zatwierdzeń firm (`approvals/<firma>.yaml`) i katalog zasobu w rejestrze. Edycja YAML zachowuje
   komentarze i resztę dokumentu (parser `yaml` na dokumencie, jak `editMarketplaces`), a wynik
   przechodzi ten sam walidator co odczyt; inaczej zapis jest odrzucony. Komentarz doklejony do
   wycinanego wpisu znika razem z nim.
5. **Odmowa usunięcia.** Zasób z `resources.mandatory` albo wymagany jako zależność (`dependenciesOf`)
   innego zasobu, który jest aktywny (w `mandatory`, `optional`, `enable` firmy albo `enable` projektu
   z `~/.cwm`), nie jest usuwany: błąd z nazwą zależnego albo z miejscem w `config.yaml`. Zależny,
   który jest usuwany w tym samym planie, nie blokuje. Jeśli którekolwiek usunięcie jest zablokowane,
   cały plan jest odrzucony (kod `1`, nic nie zapisano, także nowe i zmienione zasoby): jeden plan,
   jedno potwierdzenie, bez stanu pośredniego, który trudno wytłumaczyć. Projekty zapisane lokalnie
   (`<projekt>/.cwm`) nie są przeszukiwane; manifest projektu z `~/.cwm` wymieniający usuwany zasób
   daje tylko ostrzeżenie.
6. **Nowe zasoby w źródle.** Jak w imporcie: status `nowy`, trafiają do pakietów, nie są dopisywane do
   `optional` (komunikat po zapisie). Skan jest jeden na grupę, więc skill dodany do katalogu, z
   którego zaimportowano dwie przestrzenie (np. `global` i firmę), pojawia się w obu, tak jak przy
   dwóch kolejnych importach.
7. **Jedno potwierdzenie na terminalu** dla całego planu: zapis, usunięcia i zgoda pakietów. Wybór
   oznaczonych plików jest krokiem wyboru, nie potwierdzeniem (jak w imporcie). Bez terminala nic się
   nie zapisuje, a gdy są zmiany, kod `1` (`ok: false` w `--json`); nie ma `--yes`. `--dry-run` pokazuje
   plan i kończy się kodem `0`, chyba że plan jest zablokowany albo któreś źródło się nie udało.
   `--source <katalog>` ogranicza polecenie do jednego źródła (porównanie po `realpath` zarówno
   opcji, jak i `nativeDir` z manifestu).

### Kolejność zapisu

1. zasoby zmienione i nowe oraz pakiety (`applyImportPlan`, `applyPackPlan`);
2. czyszczenie odwołań: `config.yaml`, `company.yaml`, pakiety i ich zaufane skróty (jeden mutex
   `runtime/global`), zatwierdzenia firm (mutex firmy, jeden zapis na plik);
3. dopiero na końcu katalogi usuwanych zasobów (`removeScopedTree` w zakresie zapisu `~/.cwm`).

Cały zapis idzie pod mutexem `runtime/global` (wejścia zagnieżdżone, np. zapis zaufanych skrótów,
nie biorą go drugi raz), więc równoległy `cwm sync` albo `cwm pack`/`cwm start` zapisujący zgody
pakietów nie przeplata się z edycjami YAML.

Gdy krok 2 się nie powiedzie, katalogi zostają, więc zasób dalej jest w rejestrze ze zniknięciem
źródła i kolejny `cwm sync` dokończy usuwanie. Wpis w `config.yaml` do nieistniejącego zasobu nie
powstaje w żadnym punkcie przerwania. Pakiety i zatwierdzenia nie unieważniają wygenerowanego
profilu (jak `approvals revoke`): usunięty zasób znika z planu przy następnym `cwm start`.

## Kopia i źródło natywne

Źródło natywne nigdy nie jest zmieniane: skan i odczyt rejestru są jedynymi operacjami na nim, a
każdy zapis idzie przez writer o zakresie `~/.cwm` (`homeScope`; odmowa dowiązań na ścieżce i
chronionych segmentów, jak przy imporcie). Zmieniony zasób zachowuje poprzednią wersję jako
`.<nazwa>.old-*` (`replaceScopedTree`, jedna kopia); kopia zawiera też plik oznaczony, który ten sync
wyciął z zasobu, i leży do następnego zapisu tego zasobu albo jego usunięcia. **Usunięty zasób nie ma
kopii**: `removeScopedTree` kasuje katalog zasobu oraz rodzeństwo `.<nazwa>.old-*` i
`.<nazwa>.import-*` (dowiązanie o takiej nazwie jest odłączane bez wchodzenia w cel), żeby stara
treść nie wróciła przy ponownym imporcie jako „przerwana zamiana”. To decyzja właściciela, bo
usuwanie idzie przez ten sam writer i wymaga potwierdzenia z pełną listą (razem z miejscami, z których
zasób zostanie wycięty). Gdy źródło zniknęło przypadkiem (odmontowany dysk), potwierdzenie jest
ostatnią linią obrony; plan oznacza takie źródło `Katalog zrodlowy nie istnieje`.

## Konsekwencje

- Ponowne `cwm sync` bez zmian w źródle niczego nie zmienia (plan `bez zmian`).
- Przeniesienie źródła (inna ścieżka `--from`) wymaga `cwm import claude --from <nowa>`; stare zasoby
  wtedy zniknęłyby przy `cwm sync` ze starego źródła. Nie ma polecenia zmieniającego `nativeDir`.
- Zmiana `realpath` katalogu źródłowego (dowiązanie przestawione) aktualizuje `nativeDir` w manifestach
  przy następnym zapisie, jako zmiana zasobu.
- Nie ma blokady między równoległymi `cwm sync` i `cwm import`; jak przy innych poleceniach ręcznych,
  `cwm sync` trzyma mutex `runtime/global`, ale `cwm import` go nie bierze, więc import równoległy do syncu może nadpisać sobie zmianę w rejestrze.

## Odrzucone

- **Częściowe zastosowanie planu z zablokowanym usunięciem.** Zostawiałoby rejestr w stanie, którego
  kolejny sync znowu nie zastosuje; błąd z nazwą zależnego jest czytelniejszy.
- **Kopia usuwanych zasobów w `~/.cwm`.** Plan wskazywał, że wystarczy writer z zakresem `~/.cwm`;
  usuwanie jest świadomie potwierdzane i listowane.
- **Automatyczne dopisywanie nowych zasobów do `optional`.** Tak samo jak import: aktywacja to osobna
  decyzja.
