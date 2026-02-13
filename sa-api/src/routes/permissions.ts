import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { appPermissions, users, apps } from "../db/schema";
import type { Env, AppVariables } from "../types";
import { authMiddleware, adminOnly } from "../middleware/auth";

const permissionsRouter = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

permissionsRouter.use("*", authMiddleware, adminOnly);

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
