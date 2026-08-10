import { Hono } from "hono";
import { eq, and, or } from "drizzle-orm";
import {
  appPermissions,
  apps,
  organizations,
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

  // Super admin has no org — return empty
  if (userRole === "super_admin") {
    return c.json([]);
  }

  if (userRole === "org_admin") {
    // Admin gets all active apps in the org
    userApps = await db
      .select({
        id: apps.id,
        name: apps.name,
        type: apps.type,
        description: apps.description,
        projectId: apps.projectId,
        projectName: projects.name,
        icon: apps.icon,
        config: apps.config,
        isDefault: apps.isDefault,
        permission: appPermissions.permission,
        createdAt: apps.createdAt,
        updatedAt: apps.updatedAt,
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
      .where(and(eq(projects.orgId, orgId!), eq(apps.isActive, true)));
  } else {
    // Member gets explicitly permitted apps + the org's default app
    // First, check if org has a default app
    const [org] = orgId
      ? await db
          .select({ defaultAppId: organizations.defaultAppId })
          .from(organizations)
          .where(eq(organizations.id, orgId))
          .limit(1)
      : [null];

    // Get explicitly permitted apps
    userApps = await db
      .select({
        id: apps.id,
        name: apps.name,
        type: apps.type,
        description: apps.description,
        projectId: apps.projectId,
        projectName: projects.name,
        icon: apps.icon,
        config: apps.config,
        isDefault: apps.isDefault,
        permission: appPermissions.permission,
        createdAt: apps.createdAt,
        updatedAt: apps.updatedAt,
      })
      .from(appPermissions)
      .innerJoin(apps, eq(apps.id, appPermissions.appId))
      .innerJoin(projects, eq(projects.id, apps.projectId))
      .where(and(eq(appPermissions.userId, userId), eq(apps.isActive, true)));

    // If org has a default app and it's not already in the list, add it
    if (org?.defaultAppId && !userApps.find((a) => a.id === org.defaultAppId)) {
      const [defaultApp] = await db
        .select({
          id: apps.id,
          name: apps.name,
          type: apps.type,
          description: apps.description,
          projectId: apps.projectId,
          projectName: projects.name,
          icon: apps.icon,
          config: apps.config,
          isDefault: apps.isDefault,
          createdAt: apps.createdAt,
          updatedAt: apps.updatedAt,
        })
        .from(apps)
        .innerJoin(projects, eq(projects.id, apps.projectId))
        .where(and(eq(apps.id, org.defaultAppId), eq(apps.isActive, true)))
        .limit(1);

      if (defaultApp) {
        userApps.unshift({ ...defaultApp, permission: "view" });
      }
    }

    // Also add any apps in this org marked isDefault — bypasses app_permissions
    // entirely, distinct from the single org.defaultAppId above. Must filter by
    // orgId explicitly here (unlike the org.defaultAppId check, which is
    // inherently org-scoped) since this query can span many apps.
    if (orgId) {
      const defaultApps = await db
        .select({
          id: apps.id,
          name: apps.name,
          type: apps.type,
          description: apps.description,
          projectId: apps.projectId,
          projectName: projects.name,
          icon: apps.icon,
          config: apps.config,
          isDefault: apps.isDefault,
          createdAt: apps.createdAt,
          updatedAt: apps.updatedAt,
        })
        .from(apps)
        .innerJoin(projects, eq(projects.id, apps.projectId))
        .where(
          and(
            eq(projects.orgId, orgId),
            eq(apps.isDefault, true),
            eq(apps.isActive, true)
          )
        );

      for (const defaultApp of defaultApps) {
        if (!userApps.find((a) => a.id === defaultApp.id)) {
          userApps.unshift({ ...defaultApp, permission: "view" });
        }
      }
    }
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

  // Member must have explicit permission OR app must be the org's default
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
    // Check if this is the org's default app
    const [org] = orgId
      ? await db
          .select({ defaultAppId: organizations.defaultAppId })
          .from(organizations)
          .where(eq(organizations.id, orgId))
          .limit(1)
      : [null];

    const isOrgDefault = org?.defaultAppId === appId;
    // isDefault bypasses app_permissions for every member of the app's own
    // org — the org check here is load-bearing: without it, a member could
    // open another org's isDefault app just by knowing its id.
    const isOrgWideDefault = app.apps.isDefault && app.projects.orgId === orgId;

    if (!isOrgDefault && !isOrgWideDefault) {
      return c.json({ error: "Forbidden" }, 403);
    }

    return c.json({
      ...app.apps,
      projectName: app.projects.name,
      permission: "view",
    });
  }

  return c.json({
    ...app.apps,
    projectName: app.projects.name,
    permission: perm.permission,
  });
});

export default myApps;
