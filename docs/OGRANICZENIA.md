# Ograniczenia konwersji

last_updated: 2026-11-11

Aplikacja przenosi elementy między Claude Code i Codeksem przez model kanoniczny. Narzędzia
nie mają tych samych pojęć, więc część informacji nie przechodzi. Ten dokument mówi, co
dokładnie. Przed każdym zapisem plan eksportu pokazuje te same informacje dla konkretnego
elementu: poziom zgodności, listę pól, które znikną, i listę pól, które aplikacja dopisze.

Nic nie ginie z biblioteki. Pola bez odpowiednika zostają w bibliotece, w kopii źródła
(`snapshots/`), i wracają, jeśli eksportujesz element z powrotem do narzędzia, z którego
przyszedł. Ginie to, co trafiłoby do pliku w drugim narzędziu.

## Poziomy zgodności

Poziom jest wyliczany dla konkretnego elementu, nie dla typu. Ten sam skill bywa pełny albo
z utratą, zależnie od tego, co ma we frontmatterze.

| Poziom           | Znaczenie                                                                     |
| ---------------- | ----------------------------------------------------------------------------- |
| pełna (`full`)   | Wszystko, co element niesie, trafia do pliku docelowego                       |
| częściowa        | Część pól albo zakresu nie ma odpowiednika i nie trafia do pliku              |
| z utratą (`lossy`) | Zmienia się to, jak narzędzie widzi element, albo aplikacja musi coś dopisać |
| nieobsługiwana   | Nie powstaje żaden plik. Plan mówi dlaczego                                   |

## Per typ elementu i per narzędzie

| Typ elementu | Do Claude Code | Do Codeksa | Co ginie, co jest dopisywane |
| ------------ | -------------- | ---------- | ---------------------------- |
| Skill katalogowy | pełna, częściowa gdy ma pola z Codeksa | pełna, częściowa albo z utratą | Pola frontmattera inne niż `name` i `description` (np. `allowed-tools`) zostają w bibliotece i nie trafiają do pliku w drugim narzędziu. Z utratą w Codeksie, gdy `name` różni się od nazwy katalogu: Codex pokaże skill pod nazwą z frontmattera, inną niż katalog w Claude Code (ADR 0026). Z utratą, gdy brakuje frontmattera: aplikacja dopisze `name` i `description` |
| Skill płaski (jeden plik `.md`) | pełna, zostaje plikiem | z utratą | Codex wymaga katalogu z `SKILL.md` i frontmatterem. Powstaje katalog `skills/<nazwa>/SKILL.md`, a brakujące `name` i `description` aplikacja dopisuje. Nic nie ginie, ale plik wygląda inaczej niż źródło |
| Pliki pomocnicze skilla | pełna | pełna | Kopiowane razem ze skillem |
| Komenda | pełna, częściowa gdy ma pola z Codeksa | z utratą | Codex nie ma komend. Komenda ląduje jako skill `skills/<nazwa>/SKILL.md` i ginie wywołanie przez `/nazwa` (ADR 0021). Dopisywane `name` i `description`. Komenda i skill o tej samej nazwie to konflikt: aplikacja nie zapisze obu pod jedną nazwą i czeka na twoją decyzję. Po powrocie do biblioteki z Codeksa element jest skillem, nie komendą |
| Agent | pełna, częściowa albo z utratą | częściowa albo z utratą | Do Codeksa: dwa miejsca, plik `agents/<nazwa>.toml` i wpis `[agents.<nazwa>]` w `config.toml`. `color`, `memory` i wszystkie inne pola frontmattera (np. `tools`) giną. Model Claude'a (`haiku`, `sonnet`, `opus`) jest przybliżany poziomem rozumowania Codeksa (`low`, `medium`, `xhigh`), a sama nazwa modelu nie jest przenoszona. W drugą stronę `minimal` i `low` dają `haiku`, `medium` i `high` dają `sonnet`, `xhigh` daje `opus`. Wartość spoza tych list zostaje w bibliotece. Z utratą, gdy brakuje `name` albo `description`: aplikacja je dopisze |
| Instrukcja globalna | częściowa | częściowa | Aplikacja zarządza jednym blokiem między markerami w `CLAUDE.md` albo `AGENTS.md`, nie całym plikiem. Treść poza blokiem nie jest eksportowana ani kontrolowana (niżej) |
| Hook | pełna | częściowa | Hooki typu `command` w kluczu `hooks` pliku `settings.json` (Claude Code) albo `hooks.json` (Codex). Codex czyta tylko zdarzenia `SessionStart`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit` i `Stop` i po cichu pomija inne. Dla innego zdarzenia plan ostrzega, że może być pominięte. Hooków innego typu niż `command` oraz dopisanych ręcznie aplikacja nie rusza |
| Instrukcja projektowa | nieobsługiwana | nieobsługiwana | Leży w repozytorium, a MVP obsługuje tylko konfiguracje globalne (ADR 0032) |
| Serwery MCP i ustawienia narzędzia | nieobsługiwana | nieobsługiwana | Niżej |
| Reguły (rules) | nie są czytane | nie są czytane | Żadna lokalizacja reguł nie jest wykrywana, więc nic nie trafia do biblioteki ani do narzędzia |

Skill, komenda i agent wyeksportowane z powrotem do narzędzia, z którego przyszły, i nie
zmienione w bibliotece, zapisują dokładnie te bajty, które aplikacja przeczytała na początku.

### Pliki zapisywane jako dowiązania

Na macOS i Linuksie (na Windowsie przez symlink albo junction) katalog skilla trafia do narzędzia jako
dowiązanie do kopii w katalogu danych aplikacji (`docs/INSTALACJA.md`). Dwie konsekwencje:

- Jeśli w narzędziu leży już zwykły katalog skilla o tej nazwie, a jego zawartość różni się od
  biblioteki, eksport go zastępuje, ale dopiero po kopii całego katalogu: każdego pliku, także
  tych spoza planu (dodanych po imporcie). Plan pokazuje wpis z ostrzeżeniem „Nadpisze” i listą
  plików, które znikną z katalogu, bo nie ma ich w nowej wersji. Kopia trafia do `backups/<id>/`
  (z listą plików w MANIFEST) i do content store. Cofnięcie z widoku Historia przywraca katalog
  w całości, z trybami plików. Gdy kopii nie da się zrobić (plik nieczytelny, dowiązanie albo
  wpis specjalny wewnątrz katalogu, ponad 1000 plików), wpis jest zablokowany i nic się nie
  zmienia (ADR 0028). Pusty podkatalog nie wraca przy cofnięciu z Historii, a katalogi
  odtworzone z Historii dostają tryb 0700.
- Zmiana skilla w bibliotece trafia do narzędzia dopiero przy kolejnym eksporcie. Status
  synchronizacji sprawdza tylko, czy dowiązanie istnieje, nie czy treść kopii w katalogu danych
  się zmieniła.

## Plik `config.toml` Codeksa (ADR 0011)

`config.toml` piszesz ręcznie: ma komentarze, układ i sekcje, które aplikacja zna tylko
z nazwy. W TypeScripcie nie ma parsera TOML, który zachowuje komentarze przy zapisie, więc
aplikacja edytuje plik segmentami: zmienia wyłącznie trzyliniowe bloki
`[agents.<nazwa>]` (`description` i `config_file`). Treść agenta leży w osobnym pliku
`agents/<nazwa>.toml`, który aplikacja pisze w całości. Reszta `config.toml`, w tym
`mcp_servers`, komentarze i kolejność sekcji, zostaje bez zmian. Po edycji wynik jest
parsowany niezależnym parserem (`smol-toml`) i porównywany z oryginałem: gdyby cokolwiek poza
wpisami agentów się różniło, zapis jest odrzucany, zanim cokolwiek trafi na dysk.

Gwarancja jest węższa niż „bajt w bajt” tam, gdzie aplikacja zmienia blok agenta.

### Kiedy aplikacja odmawia edycji

Aplikacja nie zmienia pliku i odmawia eksportu **wszystkich agentów** do Codeksa w tym planie
(skille, instrukcje i hooki są niezależne), jeśli plik ma którąś z tych konstrukcji.
Komunikat w planie podaje numer linii.

| Konstrukcja | Przykład | Co zrobić |
| ----------- | -------- | --------- |
| Plik nie jest poprawnym TOML-em albo UTF-8 | brakujący cudzysłów | Popraw składnię |
| Tablica tabel w obszarze agentów | `[[agents.reviewer]]` | Zamień na zwykłą tabelę `[agents.reviewer]` |
| Klucz z kropką poza własną tabelą w obszarze agentów | `agents.reviewer.description = "x"` na górze pliku albo `foo.bar = 1` wewnątrz `[agents.reviewer]` | Przenieś klucz do jego tabeli, bez kropki w nazwie |
| Komentarz oddzielony pustą linią w bloku agenta, który aplikacja ma zmienić | pusta linia, potem `# uwaga`, w środku bloku | Usuń pustą linię albo przenieś komentarz nad nagłówek `[agents.reviewer]` |
| Wartość `description` albo `config_file` zapisana w kilku liniach w bloku do zmiany | wielolinijkowy napis | Zapisz wartość w jednej linii |
| Wpis `agents.<nazwa>` istnieje w innej formie niż tabela | `agents = { reviewer = { ... } }` | Zamień na tabelę `[agents.reviewer]` |

Po poprawce pliku zaplanuj eksport jeszcze raz. Aplikacja sprawdza te konstrukcje także
wtedy, gdy nic w pliku nie ma się zmienić, więc samo „bloki już są poprawne” nie wystarcza.
Odmowa jest zamierzona: lepsza odmowa z numerem linii niż cicha zmiana znaczenia twojej
konfiguracji.

## Blok między markerami w `CLAUDE.md` i `AGENTS.md` (ADR 0025)

Instrukcja globalna to jeden plik na narzędzie, który zwykle piszesz sam. Aplikacja zarządza
wyłącznie blokiem między dwiema liniami (każda sama w linii):

```
<!-- ai-skills-manager:start -->
<!-- ai-skills-manager:end -->
```

Markery są niewidoczne po wyrenderowaniu i nie wolno ich zmieniać: po zmianie nazwy aplikacja
przestaje rozpoznawać swój blok i dopisuje drugi.

Zachowanie:

1. Blok jest w pliku: aplikacja podmienia tylko jego wnętrze. Reszta pliku zostaje bajt w bajt.
2. Pliku nie ma: powstaje plik z samym blokiem.
3. Plik jest, markerów nie ma: blok jest dopisywany na końcu. Aplikacja nigdy nie przepisuje pliku.
4. Plik zawiera już tę samą treść bez markerów (cała, albo każda niepusta linia przy treści
   o co najmniej trzech liniach): eksport jest zablokowany jako konflikt. Otocz tę treść
   markerami ręcznie albo usuń ją z pliku, potem zaplanuj eksport jeszcze raz.

Aplikacja odmawia też, gdy markery aplikacji są uszkodzone lub powtórzone, znacznik końca stoi
przed początkiem, plik ma niezamknięty blok innego narzędzia (aplikacja nie pisze w jego
środku), treść instrukcji sama zawiera markery aplikacji, plik nie jest UTF-8, albo kilka
instrukcji globalnych celuje w ten sam plik (aplikacja ich nie łączy).

**Import bierze cały plik.** Element „instrukcja globalna” zaimportowany z `CLAUDE.md` zawiera
całą treść pliku, nie tylko blok. Jeśli zmienisz go w bibliotece i wyeksportujesz do tego samego
pliku, który nadal ma tekst z importu bez markerów, aplikacja nie dopisuje bloku po cichu.
Plan ma konflikt z dwiema decyzjami do wyboru:

- „Zamień ten fragment na blok aplikacji”: tekst zaimportowany z pliku zostaje zastąpiony blokiem
  z markerami i nową treścią, reszta pliku zostaje bajt w bajt. Oferowane, gdy ten tekst
  występuje w pliku dokładnie raz.
- „Dopisz blok na końcu”: blok z całą nową treścią trafia na koniec, a stary tekst zostaje, więc
  treść jest w pliku dwa razy.

Bez wyboru plan nie jest wykonywalny. Usunięcie linii z elementu, który nie ma snapshotu z tego
pliku, daje konflikt z punktu 4 bez wyboru: otocz treść markerami ręcznie.

Usunięcie elementu z biblioteki nie usuwa bloku z pliku.

## Serwery MCP i ustawienia narzędzi (ADR 0020)

Aplikacja nie czyta ani nie zapisuje serwerów MCP: nie wykrywa `~/.claude.json` ani
`.mcp.json`, a sekcje `mcp_servers` w `config.toml` zostają nietknięte. Pozostałe ustawienia
narzędzi też nie są przenoszone. W `settings.json` i `hooks.json` aplikacja zmienia tylko klucz
`hooks`.

Powód nie jest techniczną niemożnością, tylko ochroną zakresu i sekretów: Claude Code ma MCP
globalne i projektowe, Codex wyłącznie globalne, więc przeniesienie serwera projektowego
oznaczałoby udostępnienie go wszystkim projektom. Do tego Codex nie rozwija zmiennych
środowiskowych w `mcp_servers.*.env`, więc serwer przeniesiony mechanicznie wstałby bez
swoich danych uwierzytelniających. Odblokowanie wymaga osobnych reguł zakresów i bezpieczeństwa.

## Sieroty: aplikacja nie usuwa plików w narzędziach (ADR 0034)

Plik w narzędziu, którego biblioteka już nie realizuje, zostaje tam, gdzie jest. Usunięcie
elementu z biblioteki nie usuwa skilla, agenta, komendy ani hooka z `~/.claude` czy
`~/.codex`. Posprzątaj je ręcznie.

W tej wersji widok Synchronizacja zgłasza jako sierotę tylko blok aplikacji w pliku instrukcji,
któremu nie odpowiada żadna instrukcja w zbiorze. Osieroconych plików skilli, agentów i komend
aplikacja nie wykrywa i nie raportuje.

Jedyne usunięcie pliku w narzędziu to cofnięcie zapisu aplikacji z widoku Historia: usuwa plik,
który ten zapis utworzył. Przed cofnięciem powstaje kopia, a plan wymaga potwierdzenia.
Po cofnięciu pierwszego eksportu skilla kopia w `materialized/` zostaje w katalogu danych.

## Inne znane ograniczenia

- Nazwa (slug) jest tylko ASCII. Nazwa z polskimi literami dostaje slug przybliżony, a oryginał
  trafia do aliasów.
- Przy imporcie kandydat, którego slug różni się od istniejącego tylko wielkością liter, jest
  pomijany jako konflikt, a kreator nie pozwala zmienić sluga, żeby go mimo to przyjąć (ADR 0017).
- Dla plików współdzielonych (blok w instrukcji, segment `config.toml`, klucz `hooks`) zmiana
  zrobiona w narzędziu jest wykrywana tylko po tym, czy plik istnieje, nie po jego treści.
- Zmiana samej wartości sekretu jest niewidoczna w diffie, bo obie strony pokazują ten sam znacznik.
- Elementy z potencjalnym sekretem są przy imporcie domyślnie odznaczone.
