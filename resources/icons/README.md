# Ikony aplikacji

Monogram „AS" w kobalcie `cobalt-300` (`#7F9FFF`) na czerni, jeden kolor, bez gradientow
i efektow. Litery sa narysowane geometrycznie jako sciezki SVG w `src/make.py`, nie pochodza
z zadnego fontu. Wariant v1 (okragle S, ciezkie) wybral wlasciciel produktu.

- `icon.icns` - macOS, zaokraglone cialo 824 px na kanwie 1024 (siatka Big Sur),
- `icon.ico` - Windows, 16, 24, 32, 48, 64, 128, 256 (ksztalt plaski),
- `linux/` - Linux, rozmiary od 16 do 512 (ksztalt plaski); `electron-builder` czyta ten katalog,
- `icon.png` - 512 px, ikona okna na Linuksie i Windowsie; kopia trafia do `src/renderer/assets/icons/app-icon.png` (`src/main/bootstrap/window.ts`),
- `src/` - zrodlowe SVG i generatory.

W rozmiarach do 32 px uzywana jest wersja mala (`*-small.svg`): grubsza kreska i wiekszy
znak, bo normalna wersja zlewa sie w 16 px.

Odtworzenie wszystkich plikow (wymaga `python3`, `rsvg-convert` i `iconutil` z macOS):

    python3 resources/icons/src/build.py

Ksztalt ciala macOS to superelipsa (n = 5), przyblizenie ciaglego naroza Apple. Przed
wydaniem warto porownac je z oficjalnym szablonem ikony Apple.
