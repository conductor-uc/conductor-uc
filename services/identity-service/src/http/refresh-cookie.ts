/**
 * The refresh token's HttpOnly cookie (07 §2): `HttpOnly; SameSite=Strict`,
 * scoped to `/v1/auth` so the browser sends it only where it is needed, and
 * `Secure` unless a local plain-HTTP setup turns that off.
 */
export const REFRESH_COOKIE = 'refresh';

/**
 * A client that sends this header with the value `cookie` keeps the refresh
 * token in the cookie only: the JSON body omits it, so page script never sees
 * it. Clients without the header (services, scripts) get it in the body.
 */
export const REFRESH_TRANSPORT_HEADER = 'x-refresh-transport';

export function refreshCookieHeader(
  token: string,
  ttlDays: number,
  options: { readonly secure: boolean },
): string {
  return cookie(token, ttlDays * 24 * 60 * 60, options.secure);
}

/** Expires the cookie in the browser. */
export function clearRefreshCookieHeader(options: { readonly secure: boolean }): string {
  return cookie('', 0, options.secure);
}

function cookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    `${REFRESH_COOKIE}=${value}`,
    `Max-Age=${String(maxAgeSeconds)}`,
    'Path=/v1/auth',
    'HttpOnly',
    'SameSite=Strict',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/** One cookie's value from a `Cookie` request header, or undefined. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      const value = part.slice(separator + 1).trim();
      return value === '' ? undefined : value;
    }
  }
  return undefined;
}
