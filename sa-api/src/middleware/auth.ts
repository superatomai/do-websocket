import { createMiddleware } from "hono/factory";
import { jwtVerify } from "jose";
import type { Env, AppVariables } from "../types";

/**
 * JWT auth middleware — extracts and verifies token from Authorization header.
 * Sets userId, orgId, userRole on the context.
 */
export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: AppVariables;
}>(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const token = authHeader.slice(7);

  try {
    const secret = new TextEncoder().encode(c.env.JWT_SECRET);
    const { payload } = await jwtVerify(token, secret);

    const userId = payload.userId as string;
    const orgId = (payload.orgId as string) || null;
    const role = payload.role as "super_admin" | "org_admin" | "member";

    if (!userId || !role) {
      return c.json({ error: "Invalid token payload" }, 401);
    }

    // orgId is required for non-super_admin users
    if (role !== "super_admin" && !orgId) {
      return c.json({ error: "Invalid token payload" }, 401);
    }

    c.set("userId", userId);
    c.set("orgId", orgId);
    c.set("userRole", role);

    await next();
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
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
