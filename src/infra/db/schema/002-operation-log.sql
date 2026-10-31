-- Migracja 2: log operacji biblioteki (ADR 0019).
--
-- Log jest jedyna trescia indeksu, ktorej nie da sie odtworzyc z plikow (ADR 0014),
-- dlatego schemat z przyszlosci jest odmowa, a nie odbudowa (ADR 0029). Stany `before`
-- i `after` sa splaszczone do kolumn: zapytania o historie elementu nie maja parsowac JSON-a.

CREATE TABLE IF NOT EXISTS operation_log (
  seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
  operation           TEXT    NOT NULL,
  item_id             TEXT    NOT NULL,
  item_kind           TEXT,
  slug                TEXT,
  at                  TEXT    NOT NULL,
  before_revision     INTEGER,
  before_content_hash TEXT,
  before_version_hash TEXT,
  after_revision      INTEGER,
  after_content_hash  TEXT,
  after_version_hash  TEXT
);

CREATE INDEX IF NOT EXISTS operation_log_item ON operation_log (item_id, seq);
