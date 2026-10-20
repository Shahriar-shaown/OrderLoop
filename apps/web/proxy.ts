import { NextResponse, type NextRequest } from 'next/server';

/**
 * Sets a Content-Security-Policy with a fresh nonce on every page. Scripts run only if they carry the nonce (Next adds it to
 * its own; the layout adds it to the theme script), and a script they load is trusted in turn ('strict-dynamic'): so an
 * injected `<script>` has nothing to run with. Styles keep 'unsafe-inline' because react-native-web writes its style sheet at
 * run time. The page can talk only to itself and the API, and can never be framed.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const development = process.env.NODE_ENV === 'development';
  const api = new URL(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').origin;
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${api}${development ? ' ws: wss:' : ''}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');

  // The page reads the nonce from the request headers; the browser gets the policy on the response.
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  // Pages only: not static files, images or prefetches, which never run script.
  matcher: [
    {
      source: '/((?!_next/static|_next/image|icon.svg|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
