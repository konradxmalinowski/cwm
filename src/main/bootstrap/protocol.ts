import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

import { protocol } from 'electron';

import { isPathInside } from '../../core/model/path-containment';
import { APP_HOST, APP_SCHEME } from './paths';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/vnd.microsoft.icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/**
 * Renderer jest serwowany z wlasnego schematu, nie z `file://`. Dwa powody:
 * moduly ES nie laduja sie z `file://`, a schemat aplikacji daje jedno miejsce
 * na naglowki CSP i jeden prefiks, wzgledem ktorego sprawdzamy, czy zadanie nie
 * wychodzi poza katalog builda (ADR 0008).
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export type ResolvedTarget =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'outside' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'missing' };

export async function resolveTarget(root: string, pathname: string): Promise<ResolvedTarget> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    // Zniekszatlcona sekwencja `%` to zle zadanie, nie wyjatek, ktory zrywa obietnice handlera.
    return { kind: 'malformed' };
  }
  const candidate = resolve(join(root, decoded === '' ? 'index.html' : decoded));

  if (!isPathInside(candidate, root, { allowSame: true })) return { kind: 'outside' };

  try {
    const info = await stat(candidate);
    if (info.isFile()) return { kind: 'file', path: candidate };
    if (info.isDirectory()) return { kind: 'file', path: resolve(join(candidate, 'index.html')) };
  } catch {
    // Sciezka bez rozszerzenia to trasa aplikacji, nie plik: oddajemy powloke.
    if (extname(candidate) === '') return { kind: 'file', path: resolve(join(root, 'index.html')) };
    return { kind: 'missing' };
  }
  return { kind: 'missing' };
}

export function handleAppScheme(rendererRootDir: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) {
      return new Response('nieznany host schematu aplikacji', { status: 404 });
    }

    const target = await resolveTarget(rendererRootDir, url.pathname);
    if (target.kind === 'malformed') {
      return new Response('niepoprawny adres zadania', { status: 400 });
    }
    if (target.kind === 'outside') {
      return new Response('zadanie poza katalogiem builda', { status: 403 });
    }
    if (target.kind === 'missing') {
      return new Response('nie znaleziono', { status: 404 });
    }

    try {
      const body = await readFile(target.path);
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: { ...SECURITY_HEADERS, 'Content-Type': contentTypeFor(target.path) },
      });
    } catch {
      return new Response('nie znaleziono', { status: 404 });
    }
  });
}
