# ADR 0054: eksport do archiwum ZIP

Status: zaakceptowane w zakresie planu (2026-11-16)
Data: 2026-11-16
Dotyczy: ADR 0004 (higiena publicznego repozytorium), ADR 0008 (granica IPC), ADR 0012 (zapis przez bramkę), ADR 0033 (eksport odmawia bez katalogu głównego narzędzia), ADR 0053 (okno zapisu, chronione katalogi, zapis atomowy)
Źródło: plan `plans/2026-11-16-export-zip.md` (lokalny, poza repozytorium); kod w `src/core/services/export/zip-archive.ts`, `src/core/services/export/zip-export-service.ts`, `src/main/services/zip-export.ts`, `src/main/bootstrap/zip-export.ts`, `src/main/ipc/handlers/export.ts`, `src/renderer/app/features/export/`

## Kontekst

Wymagania źródłowe wymieniają eksport do ZIP jako funkcję kolejną, a ROADMAP trzymał ją w backlogu jako tanią, bo plan
eksportu już istnieje. Archiwum różni się od zapisu do narzędzia w jednym: to plik, który użytkownik może wysłać komuś
dalej, więc przestaje działać założenie, że dane zostają na jego komputerze, w jego własnej konfiguracji.

## Decyzje

1. **Cel "Archiwum ZIP" w kreatorze eksportu, układ plików wybranego narzędzia.** W kroku wyboru obok Claude Code i
   Codeksa jest trzeci cel. Po jego wybraniu użytkownik wskazuje układ (Claude Code albo Codex). Układ neutralny nie
   powstał: eksporter i tak zna tylko ścieżki narzędzi, a plik rozpakowany w katalogu domowym ma być od razu wzorem
   konfiguracji. Archiwum ma katalog najwyższego poziomu o nazwie narzędzia, a w nim ścieżki jak w katalogu domowym:
   `claude-code/.claude/skills/<slug>/SKILL.md`, `codex/.agents/skills/<slug>/SKILL.md`, `codex/.codex/config.toml`.
   Etykieta `$CLAUDE_CONFIG_DIR/...` albo `$CODEX_HOME/...` dostaje stałą nazwę `.claude/...` lub `.codex/...`, żeby
   archiwum nie zależało od środowiska autora.
2. **Ten sam eksporter, pusty cel.** `ZipExportService` woła `ToolExporter.plan` tak samo jak eksport do narzędzia, ale
   z czytnikiem, który o nic nie zapytany nie widzi niczego, z rootami uznanymi za istniejące (z kilku tego samego
   rodzaju aktywny jest pierwszy) i z materializacją `copy`. Wynik: każdy plik jest `create`, nic nie jest scalane z
   konfiguracją użytkownika, nie ma dowiązań, a plan jest ten sam co w kreatorze (zgodność, odmowy, konflikty). Narzędzie
   nie musi być zainstalowane (ADR 0033 dotyczy zapisu w jego katalogu). Wpisy dostają `recoverable`, bo nic nie jest
   nadpisywane, a `WriteGate` w ogóle nie bierze udziału.
3. **Format.** Własny zapis struktury ZIP (`zip-archive.ts`), kompresja deflate z Node (`zlib.deflateRawSync`,
   poziom 9) wstrzykiwana do `core` jako funkcja, bo `core` nie importuje `zlib` z infrastruktury. Brak nowej zależności,
   więc `THIRD_PARTY_NOTICES.md` bez zmian. Pokrycie: nagłówki lokalne, katalog centralny, EOCD, CRC-32, bit UTF-8
   (nazwy), bez Zip64, bez szyfrowania, bez data descriptor. Plik mniejszy po deflate jest kompresowany, inaczej
   przechowywany. Limity: 5000 plików i 64 MiB treści, powyżej odmowa (`zip-too-many-files`, `zip-too-large`), bo archiwum
   jest budowane w pamięci main przed wyborem pliku.
4. **Deterministyczność.** Wpisy w stałej kolejności (bajtowo po nazwie UTF-8), data i czas DOS stałe
   (1980-01-01 00:00:00), tryby 0644 dla plików i 0755 dla katalogów (wpisy katalogów są jawne), system `Unix`, brak
   pola dodatkowego. Te same pliki w innej kolejności dają te same bajty. Bajty strumienia deflate zależą od wersji
   zlib w Node, więc gwarancja dotyczy tej samej wersji aplikacji; manifest i skróty plików nie zależą od niczego.
5. **Ścieżki w archiwum.** `checkArchivePath` odrzuca pustą, bezwzględną (`/x`, `C:x`), z odwróconym ukośnikiem,
   z segmentem pustym, `.` albo `..`, ze znakiem sterującym, dłuższą niż 240 bajtów i z segmentem dłuższym niż 255 bajtów.
   Duplikat jest odmową także wtedy, gdy nazwy różnią się tylko wielkością liter (po rozpakowaniu na macOS lub Windowsie
   jedna zjadłaby drugą), a plik pod nazwą katalogu nadrzędnego innego pliku też. Archiwum nie ma dowiązań z konstrukcji:
   wejściem są bajty, nie ścieżki dysku.
6. **Manifest `cwm-export.json`** (w korzeniu, wersja formatu 1): `format`, `formatVersion`, `app.name`, `app.version`,
   `layout` i lista `files` z `path`, `size` i `sha256` (bez samego manifestu). Bez dat, bez nazw elementów, bez ścieżek
   bezwzględnych.
7. **Polityka prywatności i sekretów: ostrzejsza niż przy zapisie do narzędzia.** Zapis do narzędzia nie sprawdza
   klasyfikacji (cel to konfiguracja tego samego użytkownika). Archiwum opuszcza tę granicę, więc ten sam eksport dostaje
   bramkę, spójną z importem (`confirmedSecrets`) i kryterium 4 etapu 7 (profil nie niesie elementów prywatnych, projektowych
   ani z sekretami):
   - `scope: project` nigdy nie trafia do archiwum, zgody nie ma;
   - trafienie klasyfikatora sekretów, zapisane w elemencie (`secretFindings`) albo znalezione teraz w treści, plikach
     pomocniczych i snapshocie narzędzia (`classifySecrets`), wymaga jawnej zgody na element;
   - `scope: private` wymaga jawnej zgody na element (to domyślny zakres, więc zgoda jest per element, a nie jedno pole na całość);
   - `public` bez trafień wchodzi bez pytania.
   Bez zgody element jest poza archiwum i widać go na liście "Elementy, które wymagają Twojej zgody"; plan z samymi takimi
   elementami nie jest do zapisu. Zgoda to `confirmedItemIds` w `export:zip-plan` i nowy plan (nowy `planId`, stare
   archiwum przepada). Podgląd treści w planie przechodzi redakcję sekretów jak przy eksporcie do narzędzia, a samo
   archiwum zawiera treść wiernie: redakcja zmieniłaby plik, który użytkownik świadomie dołączył.
8. **Zapis.** Dwa nowe kanały: `export:zip-plan` (`{ tool, itemIds, confirmedItemIds? }`, odpowiedź w kształcie
   `ExportPlanDto` plus `zip`) i `export:zip-save` (`{ planId, approved: true }`). Archiwum jest budowane przy planie i
   trzymane w main pod `planId` (do 3 planów, 15 minut), więc do pliku trafia dokładnie to, co użytkownik widział. Ścieżkę
   wybiera main systemowym oknem zapisu z filtrem `.zip` i nigdy jej nie zwraca (odpowiedź niesie nazwę pliku bez
   katalogu). Reguły z ADR 0053, bez zmian: zapis prymitywem atomowym (`writeFileAtomic`, plik tymczasowy obok i rename,
   nowy plik 0600), odmowa w katalogach konfiguracji narzędzi, `~/.agents`, `~/.cwm`, danych aplikacji i
   `CLAUDE_CONFIG_DIR`/`CODEX_HOME` (`forbidden-location`, sprawdzane po `realpath`), nazwa bez `.zip` dostaje
   rozszerzenie, a gdy taki plik już istnieje, jest `target-exists` (system nie pytał o jego nadpisanie). Anulowanie okna
   zwraca `cancelled` i zostawia plan; udany zapis go zużywa. `export:zip-save` wchodzi pod `OperationLock`, bo dopisuje do
   logu w indeksie.
9. **Historia.** Udany zapis dopisuje wiersz `export-zip` do logu operacji: `itemId` to stała `zip-export`, `note` to
   `cel=zip; uklad=<narzędzie>; pliki=<n>; elementy=<m>`, bez ścieżki, bez `backupId`, bez `tool` (to nie zapis w
   narzędziu). Wpis nie jest cofalny (nic w narzędziu nie powstało), a w Historii czyta się jako "Eksport do archiwum ZIP:
   N plików". Awaria logu nie zamienia udanego zapisu w błąd.
10. **Interfejs.** Cel "Archiwum ZIP" i wybór układu w kroku 1, plan w tym samym widoku co plan zapisu, lista zgód z polami
    wyboru (po zmianie fokus wraca na pole), przycisk "Zapisz archiwum ZIP…" otwiera okno systemowe, wynik z nazwą pliku i
    liczbą plików. Anulowanie okna wraca do planu z jednym zdaniem. Błąd zapisu (zajęta nazwa, chroniony katalog, brak
    miejsca) zostawia plan i pozwala wybrać miejsce jeszcze raz. Tylko tekst i istniejące klasy, żadnego nowego koloru.

## Konsekwencje

- Polecenie `cwm` nie zyskało eksportu do ZIP: ten sam eksporter by go obsłużył, ale polecenie nie jest częścią tej zmiany.
- Klasyfikator sekretów jest zawodny w obie strony. Zgoda na element prywatny jest zgodą na to, co użytkownik widzi w
  podglądzie planu, nie gwarancją, że w archiwum nie ma sekretu nierozpoznanego regułami.
- Archiwum ze wszystkimi plikami elementu w pamięci main ogranicza limit 64 MiB. Większy zbiór trzeba podzielić na dwa
  eksporty.
- Archiwum nie jest podpisane. Skróty w manifeście wykrywają przypadkowe uszkodzenie, nie podmianę przez kogoś, kto może
  zmienić i plik, i manifest.
- Odczyt archiwum (import z ZIP) jest osobną funkcją i nie powstał: manifest ma wersję formatu właśnie po to.
