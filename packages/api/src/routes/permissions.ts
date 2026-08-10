import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { appPermissions, users, apps, projects } from "../db/schema";
import type { Env, AppVariables } from "../types";
import { authMiddleware, adminOnly } from "../middleware/auth";

const permissionsRouter = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

/**
 * These routes are NOT nested under /orgs/:orgId, so orgScopeGuard has no org in
 * the path to check and `adminOnly` only proves the caller is an admin somewhere.
 * Tenant isolation therefore has to be enforced per request, by resolving the
 * app and the target user back to an organization. Without it, any org_admin who
 * knew an appId could grant themselves admin on another tenant's app.
 */
permissionsRouter.use("*", authMiddleware, adminOnly);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DENIED_APP = "Not permitted for this app";
const DENIED_USER = "Not permitted for this user";

/**
 * The app must belong to the caller's organization: apps → projects → orgId.
 * Denial is indistinguishable from "no such app" so this cannot be used to
 * enumerate app IDs.
 */
async function denyAppAccess(c: any, appId: string): Promise<string | null> {
  const role = c.get("userRole");
  const callerOrgId = c.get("orgId");

  if (role === "super_admin") return null;
  if (!callerOrgId) return DENIED_APP;

  const db = c.get("db");
  const [row] = await db
    .select({ orgId: projects.orgId })
    .from(apps)
    .innerJoin(projects, eq(projects.id, apps.projectId))
    .where(eq(apps.id, appId))
    .limit(1);

  return row && row.orgId === callerOrgId ? null : DENIED_APP;
}

/**
 * The user being granted access must also belong to the caller's organization —
 * otherwise an admin could invite an outside account into their own tenant's app.
 */
async function denyUserAccess(c: any, userId: string): Promise<string | null> {
  const role = c.get("userRole");
  const callerOrgId = c.get("orgId");

  if (role === "super_admin") return null;
  if (!callerOrgId) return DENIED_USER;

  const db = c.get("db");
  const [row] = await db
    .select({ orgId: users.orgId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return row && row.orgId === callerOrgId ? null : DENIED_USER;
}

/**
 * POST /apps/:appId/permissions
 * Grant user access to app
 */
permissionsRouter.post("/:appId/permissions", async (c) => {
  const db = c.get("db");
  const appId = c.req.param("appId");
  const grantedBy = c.get("userId");
  const { userId, permission } = await c.req.json<{
    userId: string;
    permission: "view" | "edit" | "admin";
  }>();

  if (!userId || !permission) {
    return c.json({ error: "userId and permission are required" }, 400);
  }
  if (!UUID_RE.test(appId) || !UUID_RE.test(userId)) {
    return c.json({ error: "appId and userId must be valid UUIDs" }, 400);
  }
  if (!["view", "edit", "admin"].includes(permission)) {
    return c.json({ error: "Invalid permission" }, 400);
  }

  // Both sides of the grant must be inside the caller's tenant.
  const deniedApp = await denyAppAccess(c, appId);
  if (deniedApp) return c.json({ error: deniedApp }, 403);

  const deniedUser = await denyUserAccess(c, userId);
  if (deniedUser) return c.json({ error: deniedUser }, 403);

  // Check if permission already exists
  const [existing] = await db
    .select()
    .from(appPermissions)
    .where(
      and(
        eq(appPermissions.userId, userId),
        eq(appPermissions.appId, appId)
      )
    )
    .limit(1);

  if (existing) {
    return c.json(
      { error: "User already has permission for this app. Use PUT to update." },
      409
    );
  }

  const [perm] = await db
    .insert(appPermissions)
    .values({ userId, appId, permission, grantedBy })
    .returning();

  return c.json(perm, 201);
});

/**
 * GET /apps/:appId/permissions
 * List who has access to this app
 */
permissionsRouter.get("/:appId/permissions", async (c) => {
  const db = c.get("db");
  const appId = c.req.param("appId");

  if (!UUID_RE.test(appId)) {
    return c.json({ error: "appId must be a valid UUID" }, 400);
  }

  // This response carries user names and email addresses, so it must not be
  // readable for another tenant's app.
  const deniedApp = await denyAppAccess(c, appId);
  if (deniedApp) return c.json({ error: deniedApp }, 403);

  const perms = await db
    .select({
      id: appPermissions.id,
      userId: appPermissions.userId,
      userName: users.name,
      userEmail: users.email,
      permission: appPermissions.permission,
      createdAt: appPermissions.createdAt,
    })
    .from(appPermissions)
    .innerJoin(users, eq(users.id, appPermissions.userId))
    .where(eq(appPermissions.appId, appId));

  return c.json(perms);
});

/**
 * PUT /apps/:appId/permissions/:userId
 * Update user's permission level
 */
permissionsRouter.put("/:appId/permissions/:userId", async (c) => {
  const db = c.get("db");
  const appId = c.req.param("appId");
  const userId = c.req.param("userId");
  const { permission } = await c.req.json<{
    permission: "view" | "edit" | "admin";
  }>();

  if (!permission) {
    return c.json({ error: "permission is required" }, 400);
  }
  if (!UUID_RE.test(appId) || !UUID_RE.test(userId)) {
    return c.json({ error: "appId and userId must be valid UUIDs" }, 400);
  }
  if (!["view", "edit", "admin"].includes(permission)) {
    return c.json({ error: "Invalid permission" }, 400);
  }

  const deniedApp = await denyAppAccess(c, appId);
  if (deniedApp) return c.json({ error: deniedApp }, 403);

  // Raising a grant is a privilege change, so the target must be in-tenant too.
  const deniedUser = await denyUserAccess(c, userId);
  if (deniedUser) return c.json({ error: deniedUser }, 403);

  const [updated] = await db
    .update(appPermissions)
    .set({ permission })
    .where(
      and(
        eq(appPermissions.userId, userId),
        eq(appPermissions.appId, appId)
      )
    )
    .returning();

  if (!updated) {
    return c.json({ error: "Permission not found" }, 404);
  }

  return c.json(updated);
});

/**
 * DELETE /apps/:appId/permissions/:userId
 * Revoke user's access to app
 */
permissionsRouter.delete("/:appId/permissions/:userId", async (c) => {
  const db = c.get("db");
  const appId = c.req.param("appId");
  const userId = c.req.param("userId");

  if (!UUID_RE.test(appId) || !UUID_RE.test(userId)) {
    return c.json({ error: "appId and userId must be valid UUIDs" }, 400);
  }

  // Only the app is checked here, deliberately: revoking is a de-escalation, and
  // an admin must be able to clear a stale grant held by an account that has
  // since left the organization.
  const deniedApp = await denyAppAccess(c, appId);
  if (deniedApp) return c.json({ error: deniedApp }, 403);

  const [deleted] = await db
    .delete(appPermissions)
    .where(
      and(
        eq(appPermissions.userId, userId),
        eq(appPermissions.appId, appId)
      )
    )
    .returning({ id: appPermissions.id });

  if (!deleted) {
    return c.json({ error: "Permission not found" }, 404);
  }

  return c.json({ message: "Permission revoked" });
});

export default permissionsRouter;
