/**
 * Limity biblioteki, wspolne dla walidatora (core) i magazynu plikow (infra).
 * Elementy to pliki tekstowe rzedu kilobajtow (ADR 0027), wiec limity sa hojne dla uzytkownika
 * i ciasne dla importowanego repozytorium (ARCHITECTURE 8.1).
 */

/** Najglebsze drzewo, jakie magazyn potrafi odczytac i posprzatac; infra importuje te wartosc. */
export const MAX_TREE_DEPTH = 64;

/** userData na Windowsie plus `library/items/<id>/assets/` zostawia ok. 120 znakow do MAX_PATH = 260 dla narzedzi uzytkownika. */
export const MAX_ASSET_PATH_LENGTH = 120;

/** Segmenty sciezki assetu; z prefiksem `snapshots/<tool>/` ledwo siega ~1/4 `MAX_TREE_DEPTH`. */
export const MAX_ASSET_PATH_SEGMENTS = 16;

/** Zapis kosztuje ok. 15 ms na plik (fsync, odczyt kontrolny), wiec 200 plikow to ok. 3 s w kolejce zapisow. */
export const MAX_ASSETS_PER_ITEM = 200;
export const MAX_SNAPSHOT_FILES_PER_TOOL = 200;

/** Pojedynczy plik pomocniczy lub zrodlowy; skill z obrazkami miesci sie z duzym zapasem. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Suma body, assetow i snapshotow jednego elementu (kilkanascie razy wiecej niz realny skill). */
export const MAX_ITEM_BYTES = 25 * 1024 * 1024;

/** `item.json` niesie tylko metadane i `unmappedKeys`; wiecej oznacza smieci albo atak. */
export const MAX_ITEM_JSON_BYTES = 4 * 1024 * 1024;

/**
 * Najwiekszy obiekt, jaki ObjectStore musi przyjac i oddac. Rekord wersji zawiera body w JSON,
 * a escapowanie znakow sterujacych (`\u0000`, 6 bajtow) moze je powiekszyc nawet szesciokrotnie,
 * wiec zapis sprawdza rozmiar zakodowanego rekordu, a nie liczy na wzor.
 */
export const MAX_OBJECT_BYTES = 16 * 1024 * 1024;
