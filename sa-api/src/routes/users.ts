import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { users, appPermissions, apps } from "../db/schema";
import type { Env, AppVariables } from "../types";
import { authMiddleware, adminOnly } from "../middleware/auth";

const usersRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

usersRouter.use("*", authMiddleware, adminOnly);

/**
 * Hash a password using SHA-256 (same as auth login check)
 */
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * POST /orgs/:orgId/users
 * Create/invite user to org
 */
usersRouter.post("/", async (c) => {
  const db = c.get("db");
  const orgId = c.req.param("orgId")!;
  const { email, username, name, password, role } = await c.req.json<{
    email: string;
    username: string;
    name: string;
    password: string;
    role?: "org_admin" | "member";
  }>();

  if (!email || !username || !name || !password) {
    return c.json({ error: "email, username, name, and password are required" }, 400);
  }

  // Check if email already exists
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing) {
    return c.json({ error: "A user with this email already exists" }, 409);
  }

  const passwordHash = await hashPassword(password);

  const [user] = await db
    .insert(users)
    .values({
      orgId,
      email,
      username,
      name,
      passwordHash,
      role: role || "member",
    })
    .returning({
      id: users.id,
      orgId: users.orgId,
      email: users.email,
      username: users.username,
      name: users.name,
      role: users.role,
      isActive: users.isActive,
      createdAt: users.createdAt,
    });

  return c.json(user, 201);
});

/**
 * GET /orgs/:orgId/users
 * List all users in org
 */
usersRouter.get("/", async (c) => {
  const db = c.get("db");
  const orgId = c.req.param("orgId")!;

  const orgUsers = await db
    .select({
      id: users.id,
      email: users.email,
      username: users.username,
      name: users.name,
      role: users.role,
      isActive: users.isActive,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.orgId, orgId));

  return c.json(orgUsers);
});

/**
 * GET /orgs/:orgId/users/:userId
 * Get user details + their app permissions
 */
usersRouter.get("/:userId", async (c) => {
  const db = c.get("db");
  const userId = c.req.param("userId");

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      username: users.username,
      name: users.name,
      role: users.role,
      isActive: users.isActive,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  // Get user's app permissions
  const permissions = await db
    .select({
      appId: appPermissions.appId,
      appName: apps.name,
      appType: apps.type,
      permission: appPermissions.permission,
      createdAt: appPermissions.createdAt,
    })
    .from(appPermissions)
    .innerJoin(apps, eq(apps.id, appPermissions.appId))
    .where(eq(appPermissions.userId, userId));

  return c.json({ ...user, permissions });
});

/**
 * PUT /orgs/:orgId/users/:userId
 * Update user (role, name, active status)
 */
usersRouter.put("/:userId", async (c) => {
  const db = c.get("db");
  const userId = c.req.param("userId");
  const body = await c.req.json<{
    username?: string;
    name?: string;
    role?: "org_admin" | "member";
    isActive?: boolean;
  }>();

  const [updated] = await db
    .update(users)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({
      id: users.id,
      email: users.email,
      username: users.username,
      name: users.name,
      role: users.role,
      isActive: users.isActive,
      updatedAt: users.updatedAt,
    });

  if (!updated) {
    return c.json({ error: "User not found" }, 404);
  }

  return c.json(updated);
});

/**
 * DELETE /orgs/:orgId/users/:userId
 * Deactivate user (sets isActive = false, revokes all app access)
 */
usersRouter.delete("/:userId", async (c) => {
  const db = c.get("db");
  const userId = c.req.param("userId");

  // Deactivate user
  const [deactivated] = await db
    .update(users)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ id: users.id });

  if (!deactivated) {
    return c.json({ error: "User not found" }, 404);
  }

  // Revoke all app permissions
  await db
    .delete(appPermissions)
    .where(eq(appPermissions.userId, userId));

  return c.json({ message: "User deactivated and all permissions revoked" });
});

export default usersRouter;
