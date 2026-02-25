import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { projects, apps } from "../db/schema";
import type { Env, AppVariables } from "../types";
import { authMiddleware, adminOnly, orgScopeGuard } from "../middleware/auth";

const projectsRouter = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

projectsRouter.use("*", authMiddleware, adminOnly, orgScopeGuard);

/**
 * POST /orgs/:orgId/projects
 * Create project
 */
projectsRouter.post("/", async (c) => {
  const db = c.get("db");
  const orgId = c.req.param("orgId")!;
  const userId = c.get("userId");
  const { name, slug, description, icon } = await c.req.json<{
    name: string;
    slug: string;
    description?: string;
    icon?: string;
  }>();

  if (!name || !slug) {
    return c.json({ error: "name and slug are required" }, 400);
  }

  // Check slug uniqueness within org
  const [existing] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.slug, slug)))
    .limit(1);

  if (existing) {
    return c.json(
      { error: "A project with this slug already exists in the organization" },
      409
    );
  }

  const [project] = await db
    .insert(projects)
    .values({ orgId, name, slug, description, icon, createdBy: userId })
    .returning();

  return c.json(project, 201);
});

/**
 * GET /orgs/:orgId/projects
 * List all projects in org
 */
projectsRouter.get("/", async (c) => {
  const db = c.get("db");
  const orgId = c.req.param("orgId")!;

  const orgProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.orgId, orgId));

  return c.json(orgProjects);
});

/**
 * GET /orgs/:orgId/projects/:projectId
 * Get project details + its apps
 */
projectsRouter.get("/:projectId", async (c) => {
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

  const projectApps = await db
    .select()
    .from(apps)
    .where(and(eq(apps.projectId, projectId), eq(apps.isActive, true)));

  return c.json({ ...project, apps: projectApps });
});

/**
 * PUT /orgs/:orgId/projects/:projectId
 * Update project
 */
projectsRouter.put("/:projectId", async (c) => {
  const db = c.get("db");
  const projectId = c.req.param("projectId");
  const body = await c.req.json<{ name?: string; slug?: string; description?: string; icon?: string }>();

  const [updated] = await db
    .update(projects)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(projects.id, projectId))
    .returning();

  if (!updated) {
    return c.json({ error: "Project not found" }, 404);
  }

  return c.json(updated);
});

/**
 * DELETE /orgs/:orgId/projects/:projectId
 * Delete project (cascades to apps + permissions via FK)
 */
projectsRouter.delete("/:projectId", async (c) => {
  const db = c.get("db");
  const projectId = c.req.param("projectId");

  const [deleted] = await db
    .delete(projects)
    .where(eq(projects.id, projectId))
    .returning({ id: projects.id });

  if (!deleted) {
    return c.json({ error: "Project not found" }, 404);
  }

  return c.json({ message: "Project deleted" });
});

export default projectsRouter;
