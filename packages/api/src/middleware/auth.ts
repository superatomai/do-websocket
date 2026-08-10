import { createMiddleware } from "hono/factory";
import { jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { users } from "../db/schema";
import type { Env, AppVariables } from "../types";

/**
 * JWT auth middleware — verifies the token, then resolves the caller's role and
 * account status FROM THE DATABASE on every request.
 *
 * The token's `role` and `orgId` claims are deliberately ignored for
 * authorization. They are a snapshot from login, and with a long token lifetime
 * a demotion or deactivation would otherwise have no effect until expiry: a
 * downgraded admin kept full access, could re-escalate themselves, and a
 * deactivated account could still act. The signature proves *who* is calling;
 * the database decides *what they may do*.
 */
export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: AppVariables;
}>(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : c.req.query("token");

  if (!token) {
    return c.json({ error: "Missing authorization token" }, 401);
  }

  let userId: string;
  let issuedAt: number | undefined;
  try {
    const secret = new TextEncoder().encode(c.env.JWT_SECRET);
    const { payload } = await jwtVerify(token, secret);

    userId = payload.userId as string;
    issuedAt = payload.iat;
    if (!userId) {
      return c.json({ error: "Invalid token payload" }, 401);
    }
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  // Authoritative lookup. Kept outside the try above so a database fault cannot
  // be mistaken for a bad token.
  let user:
    | {
        orgId: string | null;
        role: AppVariables["userRole"];
        isActive: boolean;
        tokensValidAfter: Date | null;
      }
    | undefined;
  try {
    const db = c.get("db");
    [user] = await db
      .select({
        orgId: users.orgId,
        role: users.role,
        isActive: users.isActive,
        tokensValidAfter: users.tokensValidAfter,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
  } catch (error) {
    // Fail closed, but as 503 rather than 401: a transient DB fault must not
    // look like an expired session, or every client signs the user out.
    console.error("[auth] role lookup failed:", error);
    return c.json({ error: "Authorization service unavailable" }, 503);
  }

  if (!user) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  // Deactivation takes effect immediately, without waiting for token expiry.
  if (!user.isActive) {
    return c.json({ error: "Account is deactivated" }, 401);
  }

  // Session revocation: logout stamps a cutoff, so tokens minted before it are
  // dead even though their signature and expiry are still valid. Compared at
  // second granularity because that is all `iat` carries — a token issued in the
  // same second as the logout is treated as newer, not stale.
  if (user.tokensValidAfter) {
    const cutoffSeconds = Math.floor(user.tokensValidAfter.getTime() / 1000);
    if (issuedAt === undefined || issuedAt < cutoffSeconds) {
      return c.json({ error: "Session has been revoked, please sign in again" }, 401);
    }
  }

  // orgId is required for non-super_admin users
  if (user.role !== "super_admin" && !user.orgId) {
    return c.json({ error: "Invalid account state" }, 401);
  }

  c.set("userId", userId);
  c.set("orgId", user.orgId);
  c.set("userRole", user.role);

  await next();
});

/**
 * Middleware that requires the user to be an org_admin or super_admin.
 * Must be used after authMiddleware.
 */
export const adminOnly = createMiddleware<{
  Bindings: Env;
  Variables: AppVariables;
}>(async (c, next) => {
  const role = c.get("userRole");
  if (role !== "org_admin" && role !== "super_admin") {
    return c.json({ error: "Forbidden: admin role required" }, 403);
  }
  await next();
});

/**
 * Middleware that requires the user to be a super_admin.
 * Must be used after authMiddleware.
 */
export const superAdminOnly = createMiddleware<{
  Bindings: Env;
  Variables: AppVariables;
}>(async (c, next) => {
  const role = c.get("userRole");
  if (role !== "super_admin") {
    return c.json({ error: "Forbidden: super_admin role required" }, 403);
  }
  await next();
});

/**
 * Middleware that ensures org_admin users can only access resources in their own org.
 * Super admins bypass this check. Expects :orgId route parameter.
 * Must be used after authMiddleware.
 */
export const orgScopeGuard = createMiddleware<{
  Bindings: Env;
  Variables: AppVariables;
}>(async (c, next) => {
  const role = c.get("userRole");
  if (role === "super_admin") {
    await next();
    return;
  }
  const routeOrgId = c.req.param("orgId");
  const userOrgId = c.get("orgId");
  if (routeOrgId && routeOrgId !== userOrgId) {
    return c.json({ error: "Forbidden: cannot access another organization" }, 403);
  }
  await next();
});
