import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import {
  appPermissions,
  apps,
  projects,
  users,
} from "../db/schema";
import type { Env, AppVariables } from "../types";
import { authMiddleware } from "../middleware/auth";

const myApps = new Hono<{ Bindings: Env; Variables: AppVariables }>();

myApps.use("*", authMiddleware);

/**
 * GET /my/apps
 * List all apps the logged-in user can access
 */
myApps.get("/", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const userRole = c.get("userRole");
  const orgId = c.get("orgId");

  let userApps;

  if (userRole === "org_admin") {
    // Admin gets all active apps in the org
    userApps = await db
      .select({
        id: apps.id,
        name: apps.name,
        type: apps.type,
        projectId: apps.projectId,
        projectName: projects.name,
        config: apps.config,
        permission: appPermissions.permission,
      })
      .from(apps)
      .innerJoin(projects, eq(projects.id, apps.projectId))
      .leftJoin(
        appPermissions,
        and(
          eq(appPermissions.appId, apps.id),
          eq(appPermissions.userId, userId)
        )
      )
      .where(and(eq(projects.orgId, orgId), eq(apps.isActive, true)));
  } else {
    // Member gets only explicitly permitted apps
    userApps = await db
      .select({
        id: apps.id,
        name: apps.name,
        type: apps.type,
        projectId: apps.projectId,
        projectName: projects.name,
        config: apps.config,
        permission: appPermissions.permission,
      })
      .from(appPermissions)
      .innerJoin(apps, eq(apps.id, appPermissions.appId))
      .innerJoin(projects, eq(projects.id, apps.projectId))
      .where(and(eq(appPermissions.userId, userId), eq(apps.isActive, true)));
  }

  return c.json(userApps);
});

/**
 * GET /my/apps/:appId
 * Get app details (only if user has permission)
 */
myApps.get("/:appId", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const userRole = c.get("userRole");
  const orgId = c.get("orgId");
  const appId = c.req.param("appId");

  const [app] = await db
    .select()
    .from(apps)
    .innerJoin(projects, eq(projects.id, apps.projectId))
    .where(eq(apps.id, appId))
    .limit(1);

  if (!app) {
    return c.json({ error: "App not found" }, 404);
  }

  // Admin can access any app in their org
  if (userRole === "org_admin") {
    if (app.projects.orgId !== orgId) {
      return c.json({ error: "Forbidden" }, 403);
    }
    return c.json({ ...app.apps, projectName: app.projects.name });
  }

  // Member must have explicit permission
  const [perm] = await db
    .select()
    .from(appPermissions)
    .where(
      and(
        eq(appPermissions.userId, userId),
        eq(appPermissions.appId, appId)
      )
    )
    .limit(1);

  if (!perm) {
    return c.json({ error: "Forbidden" }, 403);
  }

  return c.json({
    ...app.apps,
    projectName: app.projects.name,
    permission: perm.permission,
  });
});

export default myApps;
