-- Migracja 3: stan synchronizacji elementow z narzedziami i kolumny logu dla zapisu do narzedzi
-- (ADR 0014, 0019, Etap 5).
--
-- `sync_state` to stan, nie tresc: utrata tabeli kosztuje tylko to, ze kazdy element wyglada na
-- niezsynchronizowany, a nastepny plan pokaze roznice. Dlatego tabela trzyma hashe, nie bajty.
-- `files_json` to lista plikow z ostatniej synchronizacji (rootId, sciezka wzgledna, hash).
-- `rootId` jest stabilny miedzy uruchomieniami (sol w `userData`), wiec ma sens po restarcie.

CREATE TABLE IF NOT EXISTS sync_state (
  item_id           TEXT    NOT NULL,
  tool              TEXT    NOT NULL,
  item_revision     INTEGER NOT NULL,
  item_content_hash TEXT    NOT NULL,
  files_json        TEXT    NOT NULL,
  synced_at         TEXT    NOT NULL,
  backup_id         TEXT    NOT NULL,
  PRIMARY KEY (item_id, tool)
);

-- Zapis do narzedzia: kolumny pozwalaja pogrupowac wiersze jednej operacji po kopii i wskazac,
-- ktora operacja cofnela ktora. Stare wiersze (biblioteka) zostaja z NULL.
ALTER TABLE operation_log ADD COLUMN tool      TEXT;
ALTER TABLE operation_log ADD COLUMN backup_id TEXT;
ALTER TABLE operation_log ADD COLUMN reverts   TEXT;

CREATE INDEX IF NOT EXISTS operation_log_backup ON operation_log (backup_id);
CREATE INDEX IF NOT EXISTS operation_log_reverts ON operation_log (reverts);
