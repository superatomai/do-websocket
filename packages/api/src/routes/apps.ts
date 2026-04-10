import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { apps, projects } from "../db/schema";
import type { Env, AppVariables } from "../types";
import { authMiddleware, adminOnly } from "../middleware/auth";

const appsRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

type ProjectMember = {
  userId: string;
  permission: "view" | "edit";
  grantedBy: string;
  grantedAt: string;
};

/**
 * Helper: verify member has access to a project
 */
async function verifyProjectAccess(
  db: any,
  projectId: string,
  userId: string,
  userRole: string,
  orgId: string | null
): Promise<{ allowed: boolean; project?: any }> {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) return { allowed: false };

  // Super admin and org admin (in their org) can access
  if (userRole === "super_admin") return { allowed: true, project };
  if (userRole === "org_admin" && project.orgId === orgId)
    return { allowed: true, project };

  // Member must be in the project's members list
  if (userRole === "member") {
    const members = (project.members as ProjectMember[]) || [];
    if (members.some((m) => m.userId === userId)) {
      return { allowed: true, project };
    }
  }

  return { allowed: false, project };
}

/**
 * POST /projects/:projectId/apps
 * Create app in project (admin only)
 */
appsRouter.post("/projects/:projectId/apps", authMiddleware, adminOnly, async (c) => {
  const db = c.get("db");
  const projectId = c.req.param("projectId");
  const userId = c.get("userId");
  const { name, type, description, config, icon } = await c.req.json<{
    name: string;
    type: "dashboard" | "app" | "report" | "chat_agent";
    description?: string;
    config?: Record<string, unknown>;
    icon?: string;
  }>();

  if (!name || !type) {
    return c.json({ error: "name and type are required" }, 400);
  }

  const [app] = await db
    .insert(apps)
    .values({ projectId, name, type, description, config, icon, createdBy: userId })
    .returning();

  return c.json(app, 201);
});

/**
 * GET /projects/:projectId/apps
 * List all apps in project. Members must be assigned to the project.
 */
appsRouter.get("/projects/:projectId/apps", authMiddleware, async (c) => {
  const db = c.get("db");
  const projectId = c.req.param("projectId");
  const userId = c.get("userId");
  const userRole = c.get("userRole");
  const orgId = c.get("orgId");

  const { allowed } = await verifyProjectAccess(db, projectId, userId, userRole, orgId);
  if (!allowed) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const projectApps = await db
    .select()
    .from(apps)
    .where(and(eq(apps.projectId, projectId), eq(apps.isActive, true)));

  return c.json(projectApps);
});

/**
 * GET /apps/:appId
 * Get app details. Members must be assigned to the app's parent project.
 */
appsRouter.get("/apps/:appId", authMiddleware, async (c) => {
  const db = c.get("db");
  const appId = c.req.param("appId");
  const userId = c.get("userId");
  const userRole = c.get("userRole");
  const orgId = c.get("orgId");

  const [app] = await db
    .select()
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1);

  if (!app) {
    return c.json({ error: "App not found" }, 404);
  }

  const { allowed } = await verifyProjectAccess(db, app.projectId, userId, userRole, orgId);
  if (!allowed) {
    return c.json({ error: "Forbidden" }, 403);
  }

  return c.json(app);
});

/**
 * PUT /apps/:appId
 * Update app (admin only)
 */
appsRouter.put("/apps/:appId", authMiddleware, adminOnly, async (c) => {
  const db = c.get("db");
  const appId = c.req.param("appId");
  const body = await c.req.json<{
    name?: string;
    type?: "dashboard" | "app" | "report" | "chat_agent";
    description?: string;
    config?: Record<string, unknown>;
    icon?: string;
    isActive?: boolean;
  }>();

  const [updated] = await db
    .update(apps)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(apps.id, appId))
    .returning();

  if (!updated) {
    return c.json({ error: "App not found" }, 404);
  }

  return c.json(updated);
});

/**
 * DELETE /apps/:appId
 * Delete app (admin only)
 */
appsRouter.delete("/apps/:appId", authMiddleware, adminOnly, async (c) => {
  const db = c.get("db");
  const appId = c.req.param("appId");

  const [deleted] = await db
    .delete(apps)
    .where(eq(apps.id, appId))
    .returning({ id: apps.id });

  if (!deleted) {
    return c.json({ error: "App not found" }, 404);
  }

  return c.json({ message: "App deleted" });
});

export default appsRouter;
