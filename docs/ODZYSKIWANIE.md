# Odzyskiwanie danych bez aplikacji

last_updated: 2026-11-11

Ten dokument pokazuje, jak ręcznie odtworzyć swoje pliki, gdy aplikacja nie startuje, zapisała
coś, czego nie chcesz, albo cofnięcie z widoku Historia nie jest dostępne. Nie potrzebujesz
aplikacji, tylko menedżera plików albo terminala i edytora tekstu.

Procedura jest sprawdzona testem `tests/integration/recovery-procedure.test.ts`. Test tworzy
prawdziwą kopię przez ten sam kod zapisu, którego używa aplikacja, a potem wykonuje kroki
z tego dokumentu samym systemem plików, bez kodu aplikacji, i porównuje bajty z tym, co było
przed zapisem. Kroki w teście mają te same oznaczenia (A1, B2 i tak dalej).

Gdzie leży katalog danych (`userData`), jest w `docs/INSTALACJA.md`. Wszystkie ścieżki niżej
są względem niego.

## Zanim zaczniesz

1. Zamknij aplikację. Zmiany robione, gdy działa, mogą się z nią zderzyć.
2. Skopiuj cały katalog danych w bezpieczne miejsce. To kosztuje chwilę i pozwala wrócić,
   jeśli pomylisz krok.
3. Nic w `backups/`, `objects/` ani `quarantine/` nie jest usuwane przez aplikację. Nie
   kasuj tych katalogów, dopóki nie odzyskasz tego, czego potrzebujesz.

## A. Odtworzenie plików narzędzia z `backups/<id>/`

Przed każdym zapisem do `~/.claude` albo `~/.codex` aplikacja robi kopię plików, które za
chwilę zmieni. Kopia leży w `backups/<id>/`: katalog `files/` z zawartością plików i plik
`MANIFEST` z opisem, co i gdzie było.

**A1. Znajdź właściwą kopię.** Nazwa katalogu to czas UTC zapisu i losowy sufiks, na przykład
`20261110T201645096Z-a1b2c3`, więc sortowanie po nazwie daje kolejność w czasie. Najnowsza kopia
jest ostatnia. Pole `createdAt` i `tool` w `MANIFEST` potwierdzą, że to ta, o którą chodzi.
Jeśli trzeba cofnąć kilka zapisów, wracaj od najnowszej kopii do starszych.

**A2. Otwórz `MANIFEST`.** To zwykły plik tekstowy w formacie JSON. Najważniejsze pola:

| Pole                        | Znaczenie                                                                  |
| --------------------------- | -------------------------------------------------------------------------- |
| `createdAt`, `tool`         | Kiedy i do którego narzędzia był zapis                                     |
| `entries[].index`           | Numer wpisu, od 1                                                          |
| `entries[].path`            | Pełna ścieżka pliku na tym komputerze                                      |
| `entries[].action`          | Co zrobił zapis: `create`, `modify`, `link`, `delete` albo `restore-link`  |
| `entries[].before`          | Stan **przed** zapisem: `state` to `file`, `missing` albo `symlink`        |
| `entries[].before.backupFile` | Dla `file`: ścieżka kopii względem katalogu kopii, np. `files/0001-SKILL.md` |
| `entries[].before.sha256`, `mode` | Dla `file`: suma kontrolna i uprawnienia pliku (np. `0644`)          |
| `entries[].before.linkTarget` | Dla `symlink`: dokąd wskazywało dowiązanie                               |
| `entries[].after`           | Stan po zapisie: `file`, `symlink`, `directory` albo `missing`             |

Wpisy można przejrzeć w terminalu.

macOS i Linux (z `jq`):

```
jq -r '.entries[] | [.index, .action, .before.state, .path] | @tsv' MANIFEST
```

Windows (PowerShell):

```
(Get-Content MANIFEST -Raw | ConvertFrom-Json).entries | Format-List index, action, path, before
```

**A3. Przejdź wpisy od ostatniego do pierwszego** (od największego `index` do 1) i dla każdego
zrób to, co mówi `before.state`. Kolejność od końca ma znaczenie, gdy katalog skilla został
zamieniony na dowiązanie albo odwrotnie.

*`before.state` = `file`: plik istniał, przywróć go.*

1. Jeśli pod `path` jest teraz dowiązanie (zapis zamienił plik na dowiązanie), usuń samo
   dowiązanie. Kopiowanie na dowiązanie zapisałoby plik w jego celu, nie w miejscu pliku.
2. Skopiuj `<katalog kopii>/<backupFile>` na `path`.
3. Na macOS i Linuksie ustaw uprawnienia z pola `mode`.
4. Sprawdź sumę: skrót SHA-256 skopiowanego pliku ma być równy `before.sha256`.

macOS i Linux:

```
rm -f "<path>"            # tylko jeśli pod path jest dowiązanie lub chcesz nadpisać
cp "<katalog kopii>/<backupFile>" "<path>"
chmod 644 "<path>"        # wartość z pola mode, bez zera na początku
shasum -a 256 "<path>"    # na Linuksie: sha256sum
```

Windows (PowerShell):

```
Copy-Item -LiteralPath "<katalog kopii>\files\<plik>" -Destination "<path>" -Force
(Get-FileHash "<path>" -Algorithm SHA256).Hash
```

Jeśli pod `path` jest dowiązanie, usuń je wcześniej poleceniem `(Get-Item "<path>").Delete()`
(plik) albo `cmd /c rmdir "<path>"` (katalog lub junction). Pole `mode` na Windowsie pomiń.

*`before.state` = `missing`: pliku wcześniej nie było, zapis go utworzył. Usuń go.*

macOS i Linux: `rm -f "<path>"`. Windows: `Remove-Item -LiteralPath "<path>" -Force`.

Jeśli `after.state` to `directory`, pod `path` jest teraz katalog z plikami skilla, który zastąpił
dowiązanie. Wpisy plików w środku masz wcześniej na liście (mają wyższe numery), więc po ich
usunięciu katalog jest pusty. Usuń go jako pusty katalog (`rmdir "<path>"`). Nie używaj usuwania
rekurencyjnego, dopóki nie obejrzysz zawartości.

*`before.state` = `symlink`: pod `path` było dowiązanie. Odtwórz je.*

1. Usuń to, co jest teraz pod `path` (plik, dowiązanie albo pusty katalog).
2. Utwórz dowiązanie o celu z `before.linkTarget`, dokładnie w takiej postaci, jak w `MANIFEST`.

macOS i Linux:

```
rm -f "<path>"
ln -s "<linkTarget>" "<path>"
```

Windows (PowerShell, symlink wymaga trybu dewelopera albo uprawnień administratora; junction nie):

```
New-Item -ItemType SymbolicLink -Path "<path>" -Target "<linkTarget>"
New-Item -ItemType Junction -Path "<path>" -Target "<linkTarget>"
```

Pierwsze polecenie dla symlinku, drugie dla junction. Jeśli dowiązanie było do katalogu,
a nie możesz utworzyć symlinku, użyj junction.

**A4. Posprzątaj puste katalogi.** Jeśli zapis utworzył katalog (na przykład
`~/.claude/skills/nowy-skill/`), po usunięciu plików katalog zostaje pusty. Usuń go, jeśli nie
chcesz go mieć.

**A5. Gdy brakuje katalogu `backups/<id>/`.** Treść każdego pliku, który zapis zastąpił,
leży też w `objects/<aa>/<sha256>`, gdzie `<sha256>` to `before.sha256` z wpisu (w
`MANIFEST`, który zachował się gdzie indziej), a `<aa>` to jego dwa pierwsze znaki. Skopiuj ten
obiekt na `path`. To dokładnie te same bajty, co w kopii.

### Co robi i czego nie robi cofnięcie ręczne

Odtwarzasz stan plików narzędzia. Biblioteka, historia i stan synchronizacji w aplikacji
o tym nie wiedzą: po uruchomieniu aplikacja może pokazać element jako zmieniony względem
narzędzia. To bezpieczne, bo niczego sama nie nadpisze bez planu i twojego potwierdzenia.

## B. Odzyskanie elementu biblioteki

Biblioteka to zwykłe pliki: `library/items/<id>/`, gdzie `<id>` to identyfikator elementu.
Nazwy katalogów zaczynające się od kropki to robocze pozostałości po przerwanym zapisie, nie
elementy.

| Plik lub katalog          | Zawartość                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `item.json`               | Metadane: `kind`, `identity.slug`, `content.title`, `content.description`, listy plików z ich skrótami, `versionRecordHash` |
| `body.md`                 | Treść elementu bez frontmattera                                                    |
| `assets/<ścieżka>`        | Pliki pomocnicze skilla                                                            |
| `snapshots/<narzędzie>/…` | Pliki dokładnie takie, jakie aplikacja przeczytała z narzędzia (`claude-code` albo `codex`) |

**B1. Znajdź element.** Przeszukaj `item.json`, żeby znaleźć nazwę: w macOS i Linuksie
`grep -l '"slug": "nazwa"' library/items/*/item.json`, w PowerShellu
`Select-String -Path library\items\*\item.json -Pattern '"slug": "nazwa"' -List`.

**B2. Odtwórz skill jako katalog.** Utwórz katalog `<slug>` w `~/.claude/skills` albo
`~/.codex/skills`, potem:

1. Skopiuj do niego zawartość `snapshots/<narzędzie>/` (zachowaj podkatalogi). To wersja z chwili
   importu, w tym `SKILL.md` z frontmatterem.
2. Skopiuj do niego zawartość `assets/` (zachowaj podkatalogi).
3. Jeśli edytowałeś element w aplikacji po imporcie, aktualna treść jest w `body.md`, a w
   `SKILL.md` ze snapshotu jest jeszcze stara. Zastąp w `SKILL.md` wszystko po drugiej linii
   `---` (końcu frontmattera) treścią `body.md`. Frontmatter zostaw ze snapshotu.
4. Jeśli element nie ma snapshotu (powstał w aplikacji), napisz `SKILL.md` sam: frontmatter
   z `name:` (z `identity.slug`) i `description:` (z `content.description` w `item.json`), a pod nim treść
   `body.md`.

Agenta, komendę i instrukcję odtwarzasz tak samo: snapshot to gotowy plik, a gdy go nie ma,
złóż go z `item.json` i `body.md`.

**B3. Odzyskaj starszą wersję z `objects/`.** Każdy zapis elementu odkłada pełny rekord
wersji w `objects/<aa>/<skrót>`. Plik rekordu to JSON, który zawiera `id` elementu,
`version.revision` i pełną treść w `content.body`.

1. Znajdź rekordy elementu po jego identyfikatorze (nazwa jego katalogu w `library/items`):
   macOS i Linux `grep -rl '"id": "<id>"' objects`, Windows
   `Select-String -Path objects\*\* -Pattern '"id": "<id>"' -List | ForEach-Object Path`.
2. Pomiń wyniki bez pola `content.body` (to kopie `item.json`, nie rekordy wersji). W pozostałych sprawdź `version.revision` oraz `version.updatedAt`, aż trafisz na wersję,
   której szukasz. Rekord aktualnej wersji ma skrót w polu `versionRecordHash` w `item.json`.
3. Treść jest w polu `content.body`. Wyciągnij ją: macOS i Linux
   `jq -r .content.body <plik rekordu> > body.md`, Windows
   `(Get-Content <plik rekordu> -Raw | ConvertFrom-Json).content.body | Set-Content body.md`.
4. Pliki pomocnicze i snapshoty tej wersji wskazują pola `assets[].bytesHash` oraz
   `source.snapshots[].files[].bytesHash` w rekordzie. Bajty leżą w `objects/<aa>/<skrót>`,
   gdzie `<aa>` to dwa pierwsze znaki skrótu. Skopiuj je pod nazwę z `relPath`.
5. Skrót SHA-256 pliku w `objects/` jest jego nazwą. Jeśli się nie zgadza, plik jest uszkodzony,
   nie używaj go.

Skróty poprzednich wersji znajdziesz też w logu operacji (sekcja C): kolumny
`before_version_hash` i `after_version_hash` to nazwy plików rekordów w `objects/`.

## C. Indeks w kwarantannie

Jeśli indeks `index.db` jest uszkodzony, aplikacja przy starcie odkłada go (z plikami `-wal`
i `-shm`) do `quarantine/index-<czas>.sqlite` i buduje nowy z plików biblioteki. Robi to także
na twoje żądanie z widoku Diagnostyka. Plik w kwarantannie jest nietknięty i aplikacja nigdy
go nie usuwa.

Zwykle nie trzeba nic robić: elementy biblioteki wracają z `library/items`, wyszukiwanie
działa po odbudowie. Stracone jest to, czego z plików odtworzyć się nie da: **log operacji**
(historia w widoku Historia) i **stan synchronizacji**. Po odbudowie każdy element wygląda
jak niezsynchronizowany, a następny plan eksportu pokaże różnicę. Kopie w `backups/` i
poprzednie wersje w `objects/` zostają, więc sekcje A i B nadal działają.

Jeśli chcesz odczytać starą historię, otwórz plik z kwarantanny programem `sqlite3` tylko do
odczytu (najlepiej na jego kopii):

```
sqlite3 -readonly "quarantine/index-<czas>.sqlite" "SELECT seq, at, operation, slug, tool, backup_id FROM operation_log ORDER BY seq"
```

`backup_id` wskazuje katalog w `backups/`. Uszkodzony plik może nie dać się otworzyć:
wtedy zostają sekcje A i B.

Nie przenoś pliku z kwarantanny z powrotem jako `index.db`. Został odłożony, bo aplikacja nie
mogła go używać, a odbudowany indeks jest zgodny z biblioteką.

Gdy aplikacja odmawia startu z komunikatem o schemacie z przyszłości, indeks zapisała nowsza
wersja aplikacji. Zainstaluj nowszą wersję, nie kasuj `index.db`: odbudowa wyrzuciłaby log
operacji.

## D. Skille, które przestały działać po usunięciu katalogu danych

Na macOS i Linuksie skill wyeksportowany do narzędzia to dowiązanie do
`materialized/<narzędzie>/<nazwa>`. Gdy katalog danych zniknął, dowiązanie wskazuje w próżnię.

**D1.** Jeśli masz kopię katalogu danych, skopiuj `materialized/<narzędzie>/<nazwa>` w miejsce
dowiązania: usuń samo dowiązanie (`rm "<narzędzie>/skills/<nazwa>"`, bez `-r`), potem
`cp -R materialized/<narzędzie>/<nazwa> <narzędzie>/skills/<nazwa>`. Windows:
`cmd /c rmdir`, potem `Copy-Item -Recurse`.

**D2.** Jeśli kopii nie ma, odtwórz skill z biblioteki według sekcji B, jeśli ona ocalała.
