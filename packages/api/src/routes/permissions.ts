import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { projects, users } from "../db/schema";
import type { Env, AppVariables } from "../types";
import { authMiddleware, adminOnly } from "../middleware/auth";

const permissionsRouter = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

type ProjectMember = {
  userId: string;
  permission: "view" | "edit";
  grantedBy: string;
  grantedAt: string;
};

/**
 * POST /projects/:projectId/members
 * Add a user to a project
 */
permissionsRouter.post("/projects/:projectId/members", authMiddleware, adminOnly, async (c) => {
  const db = c.get("db");
  const projectId = c.req.param("projectId");
  const grantedBy = c.get("userId");
  const { userId, permission } = await c.req.json<{
    userId: string;
    permission?: "view" | "edit";
  }>();

  if (!userId) {
    return c.json({ error: "userId is required" }, 400);
  }

  // Verify user exists
  const [user] = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  const members: ProjectMember[] = (project.members as ProjectMember[]) || [];

  // Check if user already a member
  if (members.some((m) => m.userId === userId)) {
    return c.json(
      { error: "User is already a member of this project. Use PUT to update." },
      409
    );
  }

  const newMember: ProjectMember = {
    userId,
    permission: permission || "view",
    grantedBy,
    grantedAt: new Date().toISOString(),
  };

  const [updated] = await db
    .update(projects)
    .set({ members: [...members, newMember], updatedAt: new Date() })
    .where(eq(projects.id, projectId))
    .returning();

  return c.json(newMember, 201);
});

/**
 * GET /projects/:projectId/members
 * List all members of a project
 */
permissionsRouter.get("/projects/:projectId/members", authMiddleware, adminOnly, async (c) => {
  const db = c.get("db");
  const projectId = c.req.param("projectId");

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  const members: ProjectMember[] = (project.members as ProjectMember[]) || [];

  if (members.length === 0) {
    return c.json([]);
  }

  // Enrich with user details
  const userIds = members.map((m) => m.userId);
  const memberUsers = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      isActive: users.isActive,
    })
    .from(users);

  const userMap = new Map(memberUsers.map((u) => [u.id, u]));

  const enriched = members
    .map((m) => ({
      ...m,
      userName: userMap.get(m.userId)?.name || null,
      userEmail: userMap.get(m.userId)?.email || null,
      userRole: userMap.get(m.userId)?.role || null,
      isActive: userMap.get(m.userId)?.isActive ?? null,
    }))
    .filter((m) => userMap.has(m.userId));

  return c.json(enriched);
});

/**
 * PUT /projects/:projectId/members/:userId
 * Update a member's permission level
 */
permissionsRouter.put("/projects/:projectId/members/:userId", authMiddleware, adminOnly, async (c) => {
  const db = c.get("db");
  const projectId = c.req.param("projectId");
  const userId = c.req.param("userId");
  const { permission } = await c.req.json<{
    permission: "view" | "edit";
  }>();

  if (!permission) {
    return c.json({ error: "permission is required" }, 400);
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  const members: ProjectMember[] = (project.members as ProjectMember[]) || [];
  const idx = members.findIndex((m) => m.userId === userId);

  if (idx === -1) {
    return c.json({ error: "User is not a member of this project" }, 404);
  }

  members[idx] = { ...members[idx], permission };

  const [updated] = await db
    .update(projects)
    .set({ members, updatedAt: new Date() })
    .where(eq(projects.id, projectId))
    .returning();

  return c.json(members[idx]);
});

/**
 * DELETE /projects/:projectId/members/:userId
 * Remove a user from a project
 */
permissionsRouter.delete("/projects/:projectId/members/:userId", authMiddleware, adminOnly, async (c) => {
  const db = c.get("db");
  const projectId = c.req.param("projectId");
  const userId = c.req.param("userId");

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  const members: ProjectMember[] = (project.members as ProjectMember[]) || [];
  const filtered = members.filter((m) => m.userId !== userId);

  if (filtered.length === members.length) {
    return c.json({ error: "User is not a member of this project" }, 404);
  }

  await db
    .update(projects)
    .set({ members: filtered, updatedAt: new Date() })
    .where(eq(projects.id, projectId));

  return c.json({ message: "Member removed from project" });
});

export default permissionsRouter;
