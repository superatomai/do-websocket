import { Hono } from "hono";
import { eq, and, sql } from "drizzle-orm";
import { apps, projects } from "../db/schema";
import type { Env, AppVariables } from "../types";
import { authMiddleware } from "../middleware/auth";

const myApps = new Hono<{ Bindings: Env; Variables: AppVariables }>();

myApps.use("*", authMiddleware);

type ProjectMember = {
  userId: string;
  permission: "view" | "edit";
  grantedBy: string;
  grantedAt: string;
};

/**
 * Helper: check if a user is a member of a project's members JSONB array
 */
function isProjectMember(
  members: ProjectMember[] | null | undefined,
  userId: string
): ProjectMember | undefined {
  if (!members || !Array.isArray(members)) return undefined;
  return members.find((m) => m.userId === userId);
}

/**
 * GET /my/projects
 * List all projects the logged-in user can access
 */
myApps.get("/projects", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const userRole = c.get("userRole");
  const orgId = c.get("orgId");

  if (userRole === "super_admin") {
    return c.json([]);
  }

  let userProjects;

  if (userRole === "org_admin") {
    // Admin gets all projects in the org
    userProjects = await db
      .select()
      .from(projects)
      .where(eq(projects.orgId, orgId!));
  } else {
    // Member gets only projects they're assigned to
    const allProjects = await db
      .select()
      .from(projects)
      .where(eq(projects.orgId, orgId!));

    userProjects = allProjects.filter((p) =>
      isProjectMember(p.members as ProjectMember[], userId)
    );
  }

  return c.json(userProjects);
});

/**
 * GET /my/projects/:projectId/apps
 * List all apps in a project the user has access to
 */
myApps.get("/projects/:projectId/apps", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const userRole = c.get("userRole");
  const orgId = c.get("orgId");
  const projectId = c.req.param("projectId");

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  // Org scope check
  if (userRole !== "super_admin" && project.orgId !== orgId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  // Member must be assigned to the project
  if (userRole === "member") {
    const membership = isProjectMember(
      project.members as ProjectMember[],
      userId
    );
    if (!membership) {
      return c.json({ error: "Forbidden" }, 403);
    }
  }

  const projectApps = await db
    .select()
    .from(apps)
    .where(and(eq(apps.projectId, projectId), eq(apps.isActive, true)));

  return c.json(projectApps);
});

/**
 * GET /my/apps
 * List all apps the logged-in user can access (flat list across all projects)
 */
myApps.get("/apps", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const userRole = c.get("userRole");
  const orgId = c.get("orgId");

  if (userRole === "super_admin") {
    return c.json([]);
  }

  let userApps;

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
        createdAt: apps.createdAt,
        updatedAt: apps.updatedAt,
      })
      .from(apps)
      .innerJoin(projects, eq(projects.id, apps.projectId))
      .where(and(eq(projects.orgId, orgId!), eq(apps.isActive, true)));
  } else {
    // Member: get projects they're assigned to, then fetch apps from those
    const allProjects = await db
      .select()
      .from(projects)
      .where(eq(projects.orgId, orgId!));

    const memberProjects = allProjects.filter((p) =>
      isProjectMember(p.members as ProjectMember[], userId)
    );

    if (memberProjects.length === 0) {
      return c.json([]);
    }

    const memberProjectIds = memberProjects.map((p) => p.id);

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
        createdAt: apps.createdAt,
        updatedAt: apps.updatedAt,
      })
      .from(apps)
      .innerJoin(projects, eq(projects.id, apps.projectId))
      .where(
        and(
          sql`${apps.projectId} IN ${memberProjectIds}`,
          eq(apps.isActive, true)
        )
      );
  }

  return c.json(userApps);
});

/**
 * GET /my/apps/:appId
 * Get app details (only if user has access to its project)
 */
myApps.get("/apps/:appId", async (c) => {
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

  // Member must be in the project's members list
  if (userRole === "member") {
    const membership = isProjectMember(
      app.projects.members as ProjectMember[],
      userId
    );
    if (!membership) {
      return c.json({ error: "Forbidden" }, 403);
    }
    return c.json({
      ...app.apps,
      projectName: app.projects.name,
      permission: membership.permission,
    });
  }

  return c.json({ error: "Forbidden" }, 403);
});

export default myApps;
