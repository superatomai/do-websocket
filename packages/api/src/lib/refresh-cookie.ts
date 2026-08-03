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

/**
 * Cookie name, scoped per environment.
 *
 * The Domain attribute below is `.superatom.ai`, which is shared by BOTH API
 * hosts — sa-api.superatom.ai and sa-api-dev.superatom.ai — while each has its
 * own database. A single cookie name therefore collides across environments:
 * the browser sends a dev-issued refresh token to prod, prod cannot find that
 * row in its own refresh_tokens table, and the user is signed out.
 *
 * That is not hypothetical — it happened when bluelinx.platform.superatom.ai
 * was repointed from the dev API to prod: every session there broke until the
 * stale cookie was cleared by hand. Distinct names let the two environments
 * hold sessions side by side.
 */
export function refreshCookieName(requestUrl: string): string {
  try {
    const host = new URL(requestUrl).hostname;
    // Any non-production API host gets its own cookie. Matching on the prod
    // host (rather than looking for "dev") means a new environment added later
    // is isolated by default instead of silently sharing prod's cookie.
    return host === "sa-api.superatom.ai" ? "sa_refresh" : "sa_refresh_dev";
  } catch {
    return "sa_refresh_dev";
  }
}

/** Legacy fixed name, kept so existing prod cookies keep working. */
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
  const name = refreshCookieName(c.req.url);

  setCookie(c, name, token, {
    httpOnly: true,
    secure: isSecureContext(c.req.url),
    sameSite: "Lax",
    path: COOKIE_PATH,
    domain: cookieDomain(c.req.url),
    maxAge: Math.floor(REFRESH_TOKEN_TTL_MS / 1000),
  });

  // A browser that previously talked to the OTHER environment still holds its
  // cookie on the shared .superatom.ai domain. Drop it on the way in, so a
  // stale cross-environment token cannot be presented on a later request.
  const stale = name === REFRESH_COOKIE_NAME ? "sa_refresh_dev" : REFRESH_COOKIE_NAME;
  deleteCookie(c, stale, {
    path: COOKIE_PATH,
    domain: cookieDomain(c.req.url),
    secure: isSecureContext(c.req.url),
    sameSite: "Lax",
  });
}

export function readRefreshCookie(c: any): string | undefined {
  return getCookie(c, refreshCookieName(c.req.url));
}

export function clearRefreshCookie(c: any): void {
  // Attributes must match the ones used to set it, or the browser keeps the
  // original cookie and logout silently fails to clear it.
  deleteCookie(c, refreshCookieName(c.req.url), {
    path: COOKIE_PATH,
    domain: cookieDomain(c.req.url),
    secure: isSecureContext(c.req.url),
    sameSite: "Lax",
  });
}
