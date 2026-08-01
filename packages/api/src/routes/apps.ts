import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { apps, projects } from "../db/schema";
import type { Env, AppVariables } from "../types";
import { authMiddleware, adminOnly } from "../middleware/auth";

const appsRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/**
 * These routes are mounted at "/" rather than under /orgs/:orgId, so there is no
 * org in the path for orgScopeGuard to check. Tenant isolation therefore has to
 * be enforced per request by resolving the project or app back to an
 * organization — without it, any authenticated user could read, and any admin
 * could modify or delete, apps belonging to any other tenant.
 */
const DENIED_PROJECT = "Not permitted for this project";
const DENIED_APP = "Not permitted for this app";

async function denyProjectAccess(c: any, projectId: string): Promise<string | null> {
  const role = c.get("userRole");
  const callerOrgId = c.get("orgId");

  if (role === "super_admin") return null;
  if (!callerOrgId) return DENIED_PROJECT;

  const db = c.get("db");
  const [row] = await db
    .select({ orgId: projects.orgId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  return row && row.orgId === callerOrgId ? null : DENIED_PROJECT;
}

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

  const denied = await denyProjectAccess(c, projectId);
  if (denied) return c.json({ error: denied }, 403);

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
appsRouter.get("/projects/:projectId/apps", authMiddleware, async (c) => {
  const db = c.get("db");
  const projectId = c.req.param("projectId");

  // Deliberately still available to any member of the owning org (no adminOnly),
  // preserving existing behaviour — only the cross-tenant reach is removed.
  const denied = await denyProjectAccess(c, projectId);
  if (denied) return c.json({ error: denied }, 403);

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
appsRouter.get("/apps/:appId", authMiddleware, async (c) => {
  const db = c.get("db");
  const appId = c.req.param("appId");

  // Members of the owning org keep read access, as before; only cross-tenant
  // reads are blocked.
  const denied = await denyAppAccess(c, appId);
  if (denied) return c.json({ error: denied }, 403);

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

  const denied = await denyAppAccess(c, appId);
  if (denied) return c.json({ error: denied }, 403);

  // Explicit allowlist. Spreading the body allowed setting any column —
  // including `projectId`, which would move an app into another tenant's project.
  const updates: {
    name?: string;
    type?: "dashboard" | "app" | "report" | "chat_agent";
    description?: string;
    config?: Record<string, unknown>;
    icon?: string;
    isActive?: boolean;
    updatedAt: Date;
  } = { updatedAt: new Date() };

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 255) {
      return c.json({ error: "Invalid name" }, 400);
    }
    updates.name = body.name;
  }
  if (body.type !== undefined) {
    if (!["dashboard", "app", "report", "chat_agent"].includes(body.type)) {
      return c.json({ error: "Invalid type" }, 400);
    }
    updates.type = body.type;
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string") {
      return c.json({ error: "Invalid description" }, 400);
    }
    updates.description = body.description;
  }
  if (body.icon !== undefined) {
    if (typeof body.icon !== "string") return c.json({ error: "Invalid icon" }, 400);
    updates.icon = body.icon;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") {
      return c.json({ error: "Invalid isActive" }, 400);
    }
    updates.isActive = body.isActive;
  }
  if (body.config !== undefined) updates.config = body.config;

  const [updated] = await db
    .update(apps)
    .set(updates)
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

  const denied = await denyAppAccess(c, appId);
  if (denied) return c.json({ error: denied }, 403);

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
