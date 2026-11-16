import type { ToolId } from '../../model/item';
import { checkAssetPath, collisionKey } from '../library/validate';
import { sha256Bytes } from '../normalization/hash';

/**
 * Zapis archiwum ZIP bez zaleznosci (ADR 0054). Funkcje sa czyste: kompresje (`deflate`) wstrzykuje
 * wywolujacy, bo `core` jej nie zalatwia sam, a wynik zalezy wylacznie od wejscia. Archiwum jest
 * deterministyczne: wpisy w stalej kolejnosci, stala data DOS, tryby 0644 (plik) i 0755 (katalog).
 * Format nie ma dowiazan, wiec dowiazanie nie moze trafic do archiwum.
 */

export const ZIP_MANIFEST_NAME = 'cwm-export.json';
export const ZIP_FORMAT = 'cwm-export';
export const ZIP_FORMAT_VERSION = 1;
/** Limity chronia pamiec main: archiwum jest budowane w calosci, zanim uzytkownik wybierze plik. */
export const ZIP_MAX_FILES = 5000;
/** Katalog centralny liczy wpisy w 16 bitach: pliki, katalogi i manifest razem. */
export const ZIP_MAX_ENTRIES = 65535;
export const ZIP_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_PATH_BYTES = 240;
const MAX_SEGMENT_BYTES = 255;

export type ZipErrorCode = 'invalid-path' | 'duplicate-path' | 'too-many-files' | 'too-large';

export class ZipError extends Error {
  constructor(
    readonly code: ZipErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipFileInput {
  /** Sciezka wzgledna z `/`, UTF-8. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface ZipManifestFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface BuildZipOptions {
  readonly appVersion: string;
  /** Uklad plikow: wedlug ktorego narzedzia powstaly sciezki. */
  readonly layout: ToolId;
  /** Kompresja deflate bez naglowka zlib (RFC 1951). */
  readonly deflate: (bytes: Uint8Array) => Uint8Array;
}

export interface BuiltZip {
  readonly bytes: Uint8Array;
  /** Pliki z manifestu, posortowane; bez samego manifestu. */
  readonly files: readonly ZipManifestFile[];
  /** Liczba plikow w archiwum razem z manifestem, bez wpisow katalogow. */
  readonly fileCount: number;
}

const encoder = new TextEncoder();

/** Znaki niewidoczne i zmieniajace kierunek tekstu: nazwa pliku z nimi wyglada inaczej, niz brzmi. */
function isInvisibleOrBidi(code: number): boolean {
  return (
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff ||
    code === 0x00ad
  );
}

/**
 * Powod odrzucenia sciezki albo `null`, gdy jest bezpieczna do zapisania w archiwum. Segmenty
 * przechodza te same reguly co sciezki plikow pomocniczych (znaki sterujace, takze C1, znaki zakazane
 * w Windows, nazwy zarezerwowane, kropka albo spacja na koncu), plus NFC i brak znakow niewidocznych.
 */
export function checkArchivePath(path: string): string | null {
  if (path === '') return 'Ścieżka jest pusta.';
  if (path.startsWith('/') || path.endsWith('/'))
    return 'Ścieżka nie może zaczynać się ani kończyć ukośnikiem.';
  if (path.includes('\\')) return 'Ścieżka zawiera odwrócony ukośnik.';
  if (/^[A-Za-z]:/.test(path)) return 'Ścieżka wygląda na bezwzględną ścieżkę z literą dysku.';
  if (path !== path.normalize('NFC')) return 'Ścieżka nie jest zapisana w NFC.';
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return 'Ścieżka zawiera znak sterujący.';
    if (isInvisibleOrBidi(code)) {
      return 'Ścieżka zawiera znak niewidoczny albo zmieniający kierunek tekstu.';
    }
  }
  if (encoder.encode(path).byteLength > MAX_PATH_BYTES) return 'Ścieżka jest za długa.';
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      return 'Ścieżka zawiera pusty segment albo "." lub "..".';
    }
    if (encoder.encode(segment).byteLength > MAX_SEGMENT_BYTES)
      return 'Nazwa w ścieżce jest za długa.';
    const problem = checkAssetPath(segment);
    if (problem !== null) return problem.message;
  }
  return null;
}

let crcTable: Uint32Array | null = null;

function table(): Uint32Array {
  if (crcTable !== null) return crcTable;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  crcTable = t;
  return t;
}

export function crc32(bytes: Uint8Array): number {
  const t = table();
  let c = 0xffffffff;
  for (const b of bytes) c = (t[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

interface Entry {
  readonly name: string;
  readonly nameBytes: Uint8Array;
  readonly isDirectory: boolean;
  readonly data: Uint8Array;
}

/** Katalogi nadrzedne sciezki: `a/b/c.txt` daje `a/` i `a/b/`. */
function parentDirectories(path: string): string[] {
  const parts = path.split('/');
  const dirs: string[] = [];
  for (let i = 1; i < parts.length; i++) dirs.push(`${parts.slice(0, i).join('/')}/`);
  return dirs;
}

/** Nazwy roznia sie tylko wielkoscia liter: po rozpakowaniu na macOS albo Windowsie jedna zjadlaby druga. */
function foldKey(path: string): string {
  return collisionKey(path);
}

function manifestJson(files: readonly ZipManifestFile[], options: BuildZipOptions): Uint8Array {
  const manifest = {
    format: ZIP_FORMAT,
    formatVersion: ZIP_FORMAT_VERSION,
    app: { name: 'cwm', version: options.appVersion },
    layout: options.layout,
    files: files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
  };
  return encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Sklada archiwum z plikow. Rzuca `ZipError` dla niebezpiecznej sciezki, duplikatu (takze tego, ktory
 * powstaje dopiero po zlozeniu wielkosci liter), zbyt wielu plikow albo zbyt duzego rozmiaru.
 */
export function buildZip(inputs: readonly ZipFileInput[], options: BuildZipOptions): BuiltZip {
  if (inputs.length + 1 > ZIP_MAX_FILES) {
    throw new ZipError('too-many-files', `Archiwum może mieć najwyżej ${ZIP_MAX_FILES} plików.`);
  }
  const seen = new Set<string>([foldKey(ZIP_MANIFEST_NAME)]);
  let total = 0;
  for (const input of inputs) {
    const problem = checkArchivePath(input.path);
    if (problem !== null) {
      throw new ZipError('invalid-path', `Nie da się zapisać pliku w archiwum. ${problem}`);
    }
    const key = foldKey(input.path);
    if (seen.has(key)) {
      throw new ZipError('duplicate-path', 'Dwa pliki miałyby w archiwum tę samą nazwę.');
    }
    seen.add(key);
    total += input.bytes.byteLength;
  }
  if (total > ZIP_MAX_TOTAL_BYTES) {
    throw new ZipError('too-large', 'Zawartość archiwum przekracza limit 64 MiB.');
  }
  // Plik nie moze byc jednoczesnie katalogiem nadrzednym innego pliku.
  for (const input of inputs) {
    for (const dir of parentDirectories(input.path)) {
      if (seen.has(foldKey(dir.slice(0, -1)))) {
        throw new ZipError('duplicate-path', 'Plik i katalog miałyby w archiwum tę samą nazwę.');
      }
    }
  }

  const sorted = [...inputs].sort((a, b) =>
    compareBytes(encoder.encode(a.path), encoder.encode(b.path)),
  );
  const files: ZipManifestFile[] = sorted.map((f) => ({
    path: f.path,
    size: f.bytes.byteLength,
    sha256: sha256Bytes(f.bytes),
  }));
  const manifest = manifestJson(files, options);

  const dirs = new Map<string, string>();
  for (const input of inputs) {
    for (const dir of parentDirectories(input.path)) {
      const key = foldKey(dir);
      const earlier = dirs.get(key);
      if (earlier !== undefined && earlier !== dir) {
        throw new ZipError('duplicate-path', 'Dwa katalogi miałyby w archiwum tę samą nazwę.');
      }
      dirs.set(key, dir);
    }
  }

  const entries: Entry[] = [
    ...[...dirs.values()].map((name) => ({
      name,
      nameBytes: encoder.encode(name),
      isDirectory: true,
      data: new Uint8Array(0),
    })),
    ...sorted.map((f) => ({
      name: f.path,
      nameBytes: encoder.encode(f.path),
      isDirectory: false,
      data: f.bytes,
    })),
    {
      name: ZIP_MANIFEST_NAME,
      nameBytes: encoder.encode(ZIP_MANIFEST_NAME),
      isDirectory: false,
      data: manifest,
    },
  ].sort((a, b) => compareBytes(a.nameBytes, b.nameBytes));

  if (entries.length > ZIP_MAX_ENTRIES) {
    throw new ZipError('too-many-files', 'Archiwum ma za dużo wpisów.');
  }

  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const stored = entry.data;
    const packed = entry.isDirectory || stored.byteLength === 0 ? stored : options.deflate(stored);
    const useDeflate = !entry.isDirectory && packed.byteLength < stored.byteLength;
    const payload = useDeflate ? packed : stored;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(stored);
    const local = new Uint8Array(30 + entry.nameBytes.byteLength);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, method === 8 || entry.isDirectory ? 20 : 10, true);
    lv.setUint16(6, 0x0800, true); // bit 11: nazwy w UTF-8
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true); // czas DOS 00:00:00
    lv.setUint16(12, 0x0021, true); // data DOS 1980-01-01
    lv.setUint32(14, crc, true);
    lv.setUint32(18, payload.byteLength, true);
    lv.setUint32(22, stored.byteLength, true);
    lv.setUint16(26, entry.nameBytes.byteLength, true);
    lv.setUint16(28, 0, true);
    local.set(entry.nameBytes, 30);

    const head = new Uint8Array(46 + entry.nameBytes.byteLength);
    const cv = new DataView(head.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, (3 << 8) | 20, true); // system: Unix
    cv.setUint16(6, method === 8 || entry.isDirectory ? 20 : 10, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x0021, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, payload.byteLength, true);
    cv.setUint32(24, stored.byteLength, true);
    cv.setUint16(28, entry.nameBytes.byteLength, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    const mode = entry.isDirectory ? 0o040755 : 0o100644;
    cv.setUint32(38, ((mode << 16) | (entry.isDirectory ? 0x10 : 0)) >>> 0, true);
    cv.setUint32(42, offset, true);
    head.set(entry.nameBytes, 46);

    chunks.push(local, payload);
    central.push(head);
    offset += local.byteLength + payload.byteLength;
  }

  const centralSize = central.reduce((sum, c) => sum + c.byteLength, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const parts = [...chunks, ...central, end];
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  if (out.byteLength >= 0xffffffff) {
    throw new ZipError('too-large', 'Archiwum przekracza limit formatu ZIP.');
  }
  return { bytes: out, files, fileCount: files.length + 1 };
}
