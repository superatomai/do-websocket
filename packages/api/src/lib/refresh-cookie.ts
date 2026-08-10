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
 *
 * Per-org cookies (multi-org sessions). One `.superatom.ai`-scoped cookie is
 * shared by every subdomain, so a single fixed name means one session per
 * browser: logging into org B overwrites org A. We suffix the name with the
 * org id (`sa_refresh_<orgId>`) so several org sessions coexist in one browser.
 * super_admin has no org and gets the unsuffixed base name, which also doubles
 * as the read fallback for sessions issued before this change. See
 * MULTI-ORG-SESSIONS-DESIGN.md.
 */

import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { REFRESH_TOKEN_TTL_MS } from "./refresh-tokens";

/**
 * Base cookie name, scoped per environment.
 *
 * The Domain attribute below is `.superatom.ai`, which is shared by BOTH API
 * hosts — sa-api.superatom.ai and sa-api-dev.superatom.ai — while each has its
 * own database. A single base name therefore collides across environments: the
 * browser sends a dev-issued refresh token to prod, prod cannot find that row
 * in its own refresh_tokens table, and the user is signed out. Distinct bases
 * let the two environments hold sessions side by side.
 */
function refreshCookieBase(requestUrl: string): string {
  try {
    const host = new URL(requestUrl).hostname;
    // Any non-production API host gets its own base. Matching on the prod host
    // (rather than looking for "dev") means a new environment added later is
    // isolated by default instead of silently sharing prod's cookie.
    return host === "sa-api.superatom.ai" ? "sa_refresh" : "sa_refresh_dev";
  } catch {
    return "sa_refresh_dev";
  }
}

/**
 * Full cookie name for an org. `orgId` omitted → the unsuffixed base, used by
 * super_admin (no org) and as the legacy read fallback.
 */
export function refreshCookieName(requestUrl: string, orgId?: string | null): string {
  const base = refreshCookieBase(requestUrl);
  return orgId ? `${base}_${orgId}` : base;
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
 * Scope to the registrable domain so a cookie set on sa-api.superatom.ai is
 * sent from every subdomain front-end. Omitted on localhost: browsers reject a
 * Domain attribute that is not a suffix of the request host, which would
 * silently break local development.
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

/**
 * Set the refresh cookie for a specific org (omit `orgId` for super_admin /
 * the global session).
 */
export function setRefreshCookie(c: any, token: string, orgId?: string | null): void {
  const name = refreshCookieName(c.req.url, orgId);

  setCookie(c, name, token, {
    httpOnly: true,
    secure: isSecureContext(c.req.url),
    sameSite: "Lax",
    path: COOKIE_PATH,
    domain: cookieDomain(c.req.url),
    maxAge: Math.floor(REFRESH_TOKEN_TTL_MS / 1000),
  });

  // A browser that previously talked to the OTHER environment still holds its
  // cookie on the shared .superatom.ai domain. Drop the same-org cookie from the
  // other environment on the way in, so a stale cross-environment token cannot be
  // presented on a later request.
  const otherBase = refreshCookieBase(c.req.url) === "sa_refresh" ? "sa_refresh_dev" : "sa_refresh";
  const stale = orgId ? `${otherBase}_${orgId}` : otherBase;
  deleteCookie(c, stale, {
    path: COOKIE_PATH,
    domain: cookieDomain(c.req.url),
    secure: isSecureContext(c.req.url),
    sameSite: "Lax",
  });
}

/** Read the refresh cookie for a specific org (omit `orgId` for the base cookie). */
export function readRefreshCookie(c: any, orgId?: string | null): string | undefined {
  return getCookie(c, refreshCookieName(c.req.url, orgId));
}

/**
 * Read the unsuffixed base cookie — the super_admin/global session, and the
 * back-compat path for sessions issued before per-org cookies. Drop the fallback
 * one release after every session has rotated onto a suffixed cookie.
 */
export function readLegacyRefreshCookie(c: any): string | undefined {
  return getCookie(c, refreshCookieBase(c.req.url));
}

/** Clear the refresh cookie for a specific org (omit `orgId` for the base cookie). */
export function clearRefreshCookie(c: any, orgId?: string | null): void {
  // Attributes must match the ones used to set it, or the browser keeps the
  // original cookie and logout silently fails to clear it.
  deleteCookie(c, refreshCookieName(c.req.url, orgId), {
    path: COOKIE_PATH,
    domain: cookieDomain(c.req.url),
    secure: isSecureContext(c.req.url),
    sameSite: "Lax",
  });
}
