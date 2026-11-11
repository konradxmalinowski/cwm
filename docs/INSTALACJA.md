# Instalacja i uruchomienie

last_updated: 2026-11-11

Ten dokument prowadzi od pobrania pliku do działającej aplikacji na macOS, Windowsie i Linuksie.
Wydania są niepodpisane (ADR 0003), więc każdy system ostrzeże cię przy pierwszym uruchomieniu.
Obejścia są niżej, osobno dla każdego systemu. Przed instalacją sprawdź sumę kontrolną pliku.

Opisane obejścia ostrzeżeń opierają się na dokumentacji systemów. Wynik instalacji na czystych
systemach jest w `docs/ROADMAP.md`, Etap 10, kryterium 4.

Co aplikacja robi i czego nie robi: `README.md`. Ograniczenia konwersji: `docs/OGRANICZENIA.md`.
Gdy coś pójdzie źle i aplikacja nie startuje: `docs/ODZYSKIWANIE.md`.

## Co pobrać

Wydania leżą na stronie Releases repozytorium. Nazwy plików mają postać
`universal-ai-skills-manager-<wersja>-<system>-<architektura>.<rozszerzenie>`. Obok plików
instalacyjnych jest plik `SHA256SUMS`.

| System  | Plik                                                                          | Uwagi                                                         |
| ------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| macOS   | `...-mac-arm64.dmg` albo `...-mac-x64.dmg`                                    | Który wybrać, jest niżej. Obok są też archiwa `.zip`          |
| Windows | `...-setup-x64.exe`                                                           | Instalator NSIS, instaluje dla bieżącego użytkownika          |
| Windows | `...-portable-x64.exe`                                                        | Wersja bez instalacji                                         |
| Linux   | `.deb` (zalecany) albo `.AppImage`                                            | Tylko x64. AppImage na Ubuntu 24.04 wymaga `--no-sandbox`     |

Aplikacje na Windows i Linuksa są budowane tylko dla x64. Na ARM tych systemów nie ma wydania.

## Sumy kontrolne

`SHA256SUMS` zawiera sumy wszystkich plików wydania, po jednej w wierszu: skrót, dwie spacje,
nazwa pliku. Pobierz go do tego samego katalogu co instalator. Skoro wydania nie są podpisane,
to jedyny sposób, żeby sprawdzić, że plik nie został zmieniony po drodze. Niezgodność oznacza,
że pliku nie uruchamiasz: pobierz go jeszcze raz.

Sprawdzasz tylko pobrany plik, nie wszystkie wiersze, więc polecenia wybierają jego wiersz.

macOS (Terminal), w katalogu z plikami:

```
grep -F "universal-ai-skills-manager-0.1.0-mac-arm64.dmg" SHA256SUMS | shasum -a 256 -c -
```

Linux, w katalogu z plikami:

```
grep -F "<nazwa pliku>" SHA256SUMS | sha256sum -c -
```

Windows (PowerShell), w katalogu z plikami:

```
$plik = "universal-ai-skills-manager-0.1.0-setup-x64.exe"
$oczekiwana = ((Select-String -Path SHA256SUMS -Pattern ([regex]::Escape($plik))).Line -split '\s+')[0]
$rzeczywista = (Get-FileHash $plik -Algorithm SHA256).Hash
if ($oczekiwana -eq $rzeczywista) { "OK" } else { "NIEZGODNE" }
```

Wynik `OK` (macOS, Linux) albo `OK` z PowerShella znaczy, że suma się zgadza. Zamień nazwę pliku
w poleceniu na swoją, dokładnie tak, jak jest w `SHA256SUMS`. Porównanie w PowerShellu nie
rozróżnia wielkości liter, a to jest tam potrzebne, bo `Get-FileHash` zwraca wielkie litery,
a `SHA256SUMS` małe.

## macOS

### Który plik

Apple Silicon (M1 i nowsze) to `arm64`, procesory Intela to `x64`. Jeśli nie wiesz, co masz,
wpisz w Terminalu `uname -m`: `arm64` znaczy Apple Silicon, `x86_64` znaczy Intel. Wersja x64
uruchomi się na Apple Silicon przez Rosettę, ale wybierz wtedy `arm64`.

### Instalacja

1. Sprawdź sumę (wyżej).
2. Otwórz plik `.dmg` i przeciągnij aplikację do `Applications`.
3. Wysuń obraz dysku.

### Pierwsze uruchomienie: Gatekeeper

Aplikacja nie ma podpisu Apple ani notaryzacji, więc macOS jej nie uruchomi od razu. Zrób
jedno z dwóch.

**Sposób 1, bez Terminala (macOS 15 Sequoia i nowsze).** Dwuklik na aplikacji, a w oknie
ostrzeżenia zamknij je, nie wybieraj przenoszenia do kosza. Otwórz `Ustawienia systemowe`, potem
`Prywatność i bezpieczeństwo`, przewiń do sekcji `Bezpieczeństwo`. Przy nazwie aplikacji
kliknij `Otwórz mimo to` i potwierdź hasłem. Od następnego razu aplikacja uruchamia się zwykle.
W macOS 15 prawy przycisk i `Otwórz` nie omijają już tego ostrzeżenia, więc nie szukaj obejścia tam.

Na starszych macOS (14 i wcześniejszych) wystarczy: Finder, prawy przycisk na aplikacji,
`Otwórz`, potem `Otwórz` w oknie potwierdzenia.

**Sposób 2, Terminal.** Jeśli macOS pisze, że aplikacja jest „uszkodzona” i proponuje kosz,
albo sposób 1 nie działa, zdejmij z niej oznaczenie kwarantanny:

```
xattr -dr com.apple.quarantine "/Applications/Universal AI Skills Manager.app"
```

Polecenie nie zmienia samej aplikacji, usuwa tylko znacznik „pobrano z internetu”, który
wymusza kontrolę Gatekeepera. Robisz to dla pliku, którego sumę wcześniej sprawdziłeś.

## Windows

### Instalator

1. Sprawdź sumę (wyżej).
2. Uruchom `...-setup-x64.exe`.
3. SmartScreen pokaże niebieskie okno `System Windows ochronił ten komputer`. Kliknij
   `Więcej informacji`, potem `Uruchom mimo to`.
4. Instalator pyta o katalog docelowy i instaluje aplikację dla bieżącego użytkownika, bez
   praw administratora. Po instalacji uruchomisz ją z menu Start.

Wersja `...-portable-x64.exe` nie instaluje się: uruchamiasz plik, SmartScreen pyta tak samo.

Jeśli plik pobrała przeglądarka i Windows oznaczył go jako pochodzący z internetu, SmartScreen
może zapytać jeszcze raz przy samej aplikacji. Odpowiedź ta sama.

## Linux

### Pakiet deb (zalecany)

Na Debianie, Ubuntu i pochodnych:

```
sudo apt install ./<nazwa pliku>.deb
```

Za `<nazwa pliku>` wstaw nazwę pobranego pliku. Aplikacja ląduje w `/opt/Universal AI Skills Manager`, w menu
aplikacji i pod poleceniem `universal-ai-skills-manager`. Instalacja ustawia pomocnika
sandboxa Chromium i na Ubuntu 24 dokłada profil AppArmor, więc aplikacja działa z włączonym
sandboxem. Tak jest testowana w CI.

### AppImage

AppImage wymaga prawa wykonywania i FUSE 2 (na Ubuntu 24.04 pakiet `libfuse2t64`):

```
chmod +x <nazwa pliku>.AppImage
./<nazwa pliku>.AppImage
```

**Na Ubuntu 24.04 AppImage nie wystartuje bez `--no-sandbox`.** Ubuntu 24.04 blokuje
nieuprzywilejowane przestrzenie nazw (AppArmor), a AppImage nie ma pomocnika sandboxa z bitem
setuid. Ustalone w Etapie 9: rozpakowany AppImage bez tej flagi pada na Ubuntu 24.04. Z flagą:

```
./<nazwa pliku>.AppImage --no-sandbox
```

Konsekwencja: wyłączasz sandbox Chromium, czyli system-owe odgrodzenie procesu okna od reszty
twojego konta. Okno aplikacji nadal ma izolację kontekstu, nie ma dostępu do Node ani sieci,
a treść jest ładowana tylko z paczki (ADR 0008). Ale gdyby ktoś znalazł lukę w samym
Chromium, proces okna działałby z twoimi uprawnieniami, bez drugiej warstwy ochrony.
Aplikacja ma dostęp do katalogów konfiguracyjnych narzędzi AI, w których mogą leżeć tokeny,
więc jeśli możesz, wybierz pakiet deb. `--no-sandbox` jest rozsądnym kompromisem tylko wtedy,
gdy deb nie wchodzi w grę.

Nie zalecamy rozluźniania ustawień AppArmor w całym systemie, żeby ominąć ten problem.

## Uruchomienie ze źródeł (dla deweloperów)

Potrzebujesz Node.js 24 (wersja w `.nvmrc`) i Gita. Kompilatora C++ nie potrzebujesz:
`better-sqlite3` ma gotowe binaria dla wszystkich systemów z tej listy.

```
git clone <adres repozytorium>
cd universal-ai-skills-manager
npm ci
npm run dev
```

`npm run dev` buduje aplikację i otwiera okno. Zmiana w rendererze przeładowuje okno, zmiana
w procesie głównym albo w preloadzie restartuje aplikację. Pozostałe polecenia i zasady
testowania są w `README.md`.

## Gdzie aplikacja trzyma dane

Katalog danych (`userData`) zależy od systemu. Nazwa katalogu to `universal-ai-skills-manager`.

| System  | Ścieżka                                                         |
| ------- | --------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/universal-ai-skills-manager`     |
| Windows | `%APPDATA%\universal-ai-skills-manager`                         |
| Linux   | `~/.config/universal-ai-skills-manager` (albo `$XDG_CONFIG_HOME`) |

Możesz uruchomić aplikację z własnym katalogiem danych: przełącznik `--user-data-dir=<katalog>`
jest wbudowany w Electrona.

W katalogu leżą:

| Element                | Co to jest                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `library/items/<id>/`  | Twoja biblioteka: po jednym katalogu na element (`item.json`, `body.md`, `assets/`, `snapshots/`) |
| `objects/<aa>/<hash>`  | Poprzednie wersje elementów i pliki z kopii zapisów, adresowane skrótem SHA-256. Nic ich nie czyści |
| `backups/<id>/`        | Kopia plików narzędzia sprzed każdego zapisu: katalog `files/` i plik `MANIFEST`                 |
| `index.db`             | Indeks SQLite: wyszukiwanie, log operacji, stan synchronizacji. Pliki są prawdą, indeks da się odbudować |
| `materialized/<tool>/` | Kopie skilli, na które wskazują dowiązania w katalogach narzędzi (niżej)                          |
| `quarantine/`          | Uszkodzony indeks odłożony przed odbudową. Aplikacja nigdy go nie usuwa                          |
| `logs/app.log`         | Log z redakcją ścieżek i sekretów, rotowany po 1 MiB                                     |
| `root-salt`            | Losowa sól do identyfikatorów lokalizacji                                                        |
| `tmp/`                 | Pliki robocze prób, sprzątane po próbie                                                          |

Poza tym Electron trzyma tam własne pliki (`Cache`, `Local Storage`, `Preferences`), do których
aplikacja nie zapisuje niczego z twojej konfiguracji.

### Dowiązania w katalogach narzędzi

Na macOS i Linuksie skill, który eksportujesz do narzędzia, trafia tam jako dowiązanie
symboliczne do `materialized/<tool>/<nazwa>`, nie jako kopia. Na Windowsie katalog skilla jest
dowiązany przez junction, a pojedyncze pliki są kopiowane (symlink wymaga na Windowsie trybu dewelopera albo uprawnień administratora).
Gdy system odmówi dowiązania, aplikacja zapisuje kopię i mówi o tym w raporcie. Agenci,
komendy, instrukcje i hooki są zawsze zwykłymi plikami.

Skutek praktyczny: **jeśli skasujesz katalog danych aplikacji, dowiązania w `~/.claude/skills`
albo `~/.codex/skills` zostaną puste, a skille przestaną działać.** Przed usunięciem katalogu
danych wyeksportuj skille jako kopie albo skopiuj `materialized/` z powrotem do narzędzi
(`docs/ODZYSKIWANIE.md`). Odinstalowanie samej aplikacji nie usuwa katalogu danych.

## Zakres

Aplikacja obsługuje wyłącznie konfiguracje globalne (ADR 0032): `~/.claude` (albo
`$CLAUDE_CONFIG_DIR`), `~/.codex` (albo `$CODEX_HOME`) i wspólny `~/.agents`. Pliki
`CLAUDE.md`, `AGENTS.md` i `.mcp.json` leżące w repozytoriach projektów nie trafiają do
biblioteki i nie są nigdy zapisywane. Konfiguracje projektowe są zaplanowane po wydaniu MVP.

Eksport działa tylko do narzędzia, którego katalog główny już istnieje (ADR 0033). Katalog
`~/.agents` sam nie oznacza, że masz Codeksa. Brakujące podkatalogi w istniejącym katalogu
głównym aplikacja tworzy przy pierwszym eksporcie.
