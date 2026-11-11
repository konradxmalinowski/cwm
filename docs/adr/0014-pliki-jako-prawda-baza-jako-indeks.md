# ADR 0014: Pliki są prawdą, baza jest indeksem

Status: zaakceptowane, uzupełnione przez ADR 0029
Data: 2026-10-20

Nazwa produktu zmieniona przez ADR 0035: `userData` to od v0.2.0 `<appData>/CWM`, a katalog v0.1.0 jest migrowany przez kopię. Układ opisany niżej bez zmian.

> Uzupełnienie wprowadzone przez ADR 0029: odtwarzalność indeksu jest ścieżką kodu, nie
> właściwością na papierze. Uszkodzony indeks jest odbudowywany po kwarantannie starego pliku,
> a nie powodem odmowy startu. Wyjątek wymieniony niżej (log operacji, którego z plików
> odtworzyć się nie da) jest powodem, dla którego indeksu ze schematem z przyszłości
> odbudowywać **nie wolno**.

## Kontekst

Biblioteka przechowuje skille, agentów, komendy, instrukcje, reguły, hooki, pliki pomocnicze
i profile. Większość z nich to w istocie pliki Markdown z metadanymi. Aplikacja potrzebuje
jednocześnie wyszukiwania pełnotekstowego, filtrowania, stanu synchronizacji per cel i logu
operacji.

Użytkownik, który przenosi całą swoją konfigurację do tej aplikacji, musi mieć pewność, że jego
dane nie są uwięzione w formacie, do którego dostęp ma tylko ta aplikacja.

## Rozważane opcje

**Wszystko w SQLite, treści jako BLOB.** Jedno miejsce, transakcje, łatwy backup przez skopiowanie
jednego pliku. Przeciw: użytkownik nie może podejrzeć, zacommitować ani przeszukać swoich
skilli bez aplikacji. Uszkodzenie bazy to utrata wszystkiego. Dla produktu, którego celem jest
porządek w konfiguracji, to zły sygnał.

**Wszystko w plikach, bez bazy, indeks budowany w pamięci przy starcie.** Pełna przejrzystość,
ale wyszukiwanie pełnotekstowe po treści setek elementów przy każdym starcie, i brak trwałego
logu operacji.

**Pliki jako prawda, baza jako odtwarzalny indeks.**

## Decyzja

Układ danych w `userData` (szczegóły w ARCHITECTURE sekcja 9):

- `library/items/<itemId>/` z `item.json`, `body.md`, `assets/` i `snapshots/<tool>/`. To jest
  prawda o treści.
- `index.sqlite` z metadanymi, wyszukiwaniem FTS5, stanem synchronizacji i logiem operacji.
  To jest indeks.
- `objects/<aa>/<sha256>` content-addressed store dla wersji i backupów.
- `backups/<timestamp>/` z MANIFEST przed operacją destrukcyjną.
- `logs/` z redakcją sekretów.

**Twarda reguła: baza musi być odtwarzalna z plików.** Utrata `index.sqlite` kosztuje czas
przebudowy, nie dane. Jedyny wyjątek to log operacji, który z plików odtworzyć się nie da; dlatego
log jest duplikowany w `backups/<timestamp>/MANIFEST`, czyli w formie tekstowej obok danych,
których dotyczy.

## Konsekwencje

Użytkownik może wejść do `library/` i zobaczyć swoje skille jako pliki. Może ten katalog
zacommitować, zrobić mu kopię, przeszukać zwykłym grepem. To jest realna wartość produktu,
nie tylko ustępstwo.

Spójność między plikami a indeksem trzeba utrzymywać świadomie. Zapis idzie zawsze w kolejności:
pliki, potem indeks. Przerwanie między nimi daje indeks nieaktualny, nie dane utracone,
a Diagnostics ma wykrywać rozbieżność i proponować przebudowę.

Wymiana bazy na inną implementację (ADR 0007) nie wymaga migracji danych, bo dane nie są w bazie.

Koszt: dwa miejsca zapisu zamiast jednego i obowiązek napisania przebudowy indeksu w Etapie 2,
a nie później.
