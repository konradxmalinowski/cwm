-- Migracja 4: indeks biblioteki i wyszukiwanie pelnotekstowe (ADR 0014, ADR 0029).
--
-- `items` i `items_fts` sa kopia plikow z `library/items`, wiec ich utrata nic nie kosztuje poza
-- czasem odbudowy. Migracja nie ma kroku wstecz: starsza wersja aplikacji widzi schemat z
-- przyszlosci i odmawia startu, a wyjsciem jest reczna odbudowa z Diagnostyki (ADR 0030).
-- Nowa tabela jest pusta po migracji; start aplikacji wypelnia ja z plikow, gdy liczba
-- elementow sie nie zgadza.
--
-- `seq` jest kluczem laczacym wiersz z wpisem FTS (rowid), zeby usuniecie i podmiana nie
-- skanowaly calej tabeli pelnotekstowej.

CREATE TABLE IF NOT EXISTS items (
  seq          INTEGER PRIMARY KEY,
  id           TEXT    NOT NULL UNIQUE,
  kind         TEXT    NOT NULL,
  slug         TEXT    NOT NULL,
  slug_key     TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  description  TEXT    NOT NULL,
  revision     INTEGER NOT NULL,
  content_hash TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);

-- ADR 0017: unikalnosc po typie i kluczu kolizji jest w bazie obok walidatora.
CREATE UNIQUE INDEX IF NOT EXISTS items_kind_slug_key ON items (kind, slug_key);

CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title,
  description,
  body,
  slug,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Wpis logu z krotkim wynikiem operacji, np. recznej odbudowy indeksu (ADR 0030).
ALTER TABLE operation_log ADD COLUMN note TEXT;
