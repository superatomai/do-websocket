/**
 * Refresh-token cookie.
 *
 * The refresh token lives in an httpOnly cookie rather than localStorage, which
 * is the entire point of the split: an XSS payload can read the access token
 * (15 minutes) but cannot read the refresh token (30 days). Putting both in
 * localStorage would keep rotation's detection benefit and throw away its
 * containment benefit.
 *
 * This works because every front-end is under superatom.ai, so a cookie scoped
 * to `.superatom.ai` is same-site for live.superatom.ai → sa-api.superatom.ai
 * and SameSite=Lax applies. Lax also blocks cross-site POSTs, which is the CSRF
 * control for /auth/refresh.
 */

import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { REFRESH_TOKEN_TTL_MS } from "./refresh-tokens";

export const REFRESH_COOKIE_NAME = "sa_refresh";

/**
 * Restricting the path means the cookie is only attached to auth endpoints —
 * it is never sent on ordinary API calls, so it cannot leak through an
 * unrelated handler or a proxy log.
 */
const COOKIE_PATH = "/auth";

/**
 * Scope to the registrable domain so every subdomain front-end shares one
 * session. Omitted on localhost: browsers reject a Domain attribute that is not
 * a suffix of the request host, which would silently break local development.
 */
function cookieDomain(requestUrl: string): string | undefined {
  try {
    const host = new URL(requestUrl).hostname;
    return host.endsWith("superatom.ai") ? ".superatom.ai" : undefined;
  } catch {
    return undefined;
  }
}

/** Secure cookies are dropped over plaintext, so allow http only on localhost. */
function isSecureContext(requestUrl: string): boolean {
  try {
    return new URL(requestUrl).protocol === "https:";
  } catch {
    return true;
  }
}

export function setRefreshCookie(c: any, token: string): void {
  setCookie(c, REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isSecureContext(c.req.url),
    sameSite: "Lax",
    path: COOKIE_PATH,
    domain: cookieDomain(c.req.url),
    maxAge: Math.floor(REFRESH_TOKEN_TTL_MS / 1000),
  });
}

export function readRefreshCookie(c: any): string | undefined {
  return getCookie(c, REFRESH_COOKIE_NAME);
}

export function clearRefreshCookie(c: any): void {
  // Attributes must match the ones used to set it, or the browser keeps the
  // original cookie and logout silently fails to clear it.
  deleteCookie(c, REFRESH_COOKIE_NAME, {
    path: COOKIE_PATH,
    domain: cookieDomain(c.req.url),
    secure: isSecureContext(c.req.url),
    sameSite: "Lax",
  });
}
