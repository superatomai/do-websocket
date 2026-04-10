import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { users, projects } from "../db/schema";
import type { Env, AppVariables } from "../types";
import { authMiddleware, adminOnly, orgScopeGuard } from "../middleware/auth";

const usersRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

usersRouter.use("*", authMiddleware, adminOnly, orgScopeGuard);

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
    role?: "super_admin" | "org_admin" | "member";
  }>();

  if (!email || !username || !name || !password) {
    return c.json({ error: "email, username, name, and password are required" }, 400);
  }

  // Nobody should create super_admin via this endpoint
  if (role === "super_admin") {
    return c.json({ error: "Cannot create super_admin users via this endpoint" }, 403);
  }

  // Only super_admin or org_admin can create org_admin users
  if (role === "org_admin" && !["super_admin", "org_admin"].includes(c.get("userRole"))) {
    return c.json({ error: "Only admins can create org_admin users" }, 403);
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
 * Get user details + their project memberships
 */
usersRouter.get("/:userId", async (c) => {
  const db = c.get("db");
  const orgId = c.req.param("orgId")!;
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

  // Get projects this user is a member of
  type ProjectMember = { userId: string; permission: string; grantedBy: string; grantedAt: string };
  const orgProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.orgId, orgId));

  const userProjects = orgProjects
    .filter((p) => {
      const members = (p.members as ProjectMember[]) || [];
      return members.some((m) => m.userId === userId);
    })
    .map((p) => {
      const members = (p.members as ProjectMember[]) || [];
      const membership = members.find((m) => m.userId === userId)!;
      return {
        projectId: p.id,
        projectName: p.name,
        projectSlug: p.slug,
        permission: membership.permission,
        grantedAt: membership.grantedAt,
      };
    });

  return c.json({ ...user, projects: userProjects });
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

  // Only super_admin or org_admin can promote to org_admin
  if (body.role === "org_admin" && !["super_admin", "org_admin"].includes(c.get("userRole"))) {
    return c.json({ error: "Only admins can assign org_admin role" }, 403);
  }

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
 * Deactivate user (sets isActive = false, removes from all project memberships)
 */
usersRouter.delete("/:userId", async (c) => {
  const db = c.get("db");
  const orgId = c.req.param("orgId")!;
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

  // Remove user from all project memberships in this org
  type PM = { userId: string; permission: "view" | "edit"; grantedBy: string; grantedAt: string };
  const orgProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.orgId, orgId));

  for (const project of orgProjects) {
    const members = (project.members as PM[]) || [];
    const filtered = members.filter((m) => m.userId !== userId);
    if (filtered.length !== members.length) {
      await db
        .update(projects)
        .set({ members: filtered, updatedAt: new Date() })
        .where(eq(projects.id, project.id));
    }
  }

  return c.json({ message: "User deactivated and removed from all projects" });
});

export default usersRouter;
