import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { apps } from "../db/schema";
import type { Env, AppVariables } from "../types";
import { authMiddleware, adminOnly } from "../middleware/auth";

const appsRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/**
 * POST /projects/:projectId/apps
 * Create app in project
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
 * List all apps in project
 */
appsRouter.get("/projects/:projectId/apps", authMiddleware, adminOnly, async (c) => {
  const db = c.get("db");
  const projectId = c.req.param("projectId");

  const projectApps = await db
    .select()
    .from(apps)
    .where(and(eq(apps.projectId, projectId), eq(apps.isActive, true)));

  return c.json(projectApps);
});

/**
 * GET /apps/:appId
 * Get app details
 */
appsRouter.get("/apps/:appId", authMiddleware, adminOnly, async (c) => {
  const db = c.get("db");
  const appId = c.req.param("appId");

  const [app] = await db
    .select()
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1);

  if (!app) {
    return c.json({ error: "App not found" }, 404);
  }

  return c.json(app);
});

/**
 * PUT /apps/:appId
 * Update app
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
 * Delete app (cascades permissions via FK)
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
