import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { projects, apps } from "../db/schema";
import type { Env, AppVariables } from "../types";
import { authMiddleware, adminOnly, orgScopeGuard } from "../middleware/auth";

const DEFAULT_DESIGN_SYSTEM = {
  colors: {
    primary: "#009193",
    secondary: "#FFFFFF",
  },
};

const projectsRouter = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

// Read routes: any authenticated user in the org (including members)
projectsRouter.get("*", authMiddleware, orgScopeGuard);
// Write routes: admin only
projectsRouter.post("*", authMiddleware, adminOnly, orgScopeGuard);
projectsRouter.put("*", authMiddleware, adminOnly, orgScopeGuard);
projectsRouter.delete("*", authMiddleware, adminOnly, orgScopeGuard);

/**
 * POST /orgs/:orgId/projects
 * Create project
 */
projectsRouter.post("/", async (c) => {
  const db = c.get("db");
  const orgId = c.req.param("orgId")!;
  const userId = c.get("userId");
  const { name, slug, description, icon, designSystem } = await c.req.json<{
    name: string;
    slug: string;
    description?: string;
    icon?: string;
    designSystem?: Record<string, unknown>;
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
    .values({ orgId, name, slug, description, icon, designSystem: designSystem || DEFAULT_DESIGN_SYSTEM, createdBy: userId })
    .returning();

  return c.json(project, 201);
});

/**
 * GET /orgs/:orgId/projects
 * List projects in org. Admins see all, members see only assigned projects.
 */
projectsRouter.get("/", async (c) => {
  const db = c.get("db");
  const orgId = c.req.param("orgId")!;
  const userId = c.get("userId");
  const userRole = c.get("userRole");

  const orgProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.orgId, orgId));

  // Members only see projects they're assigned to
  if (userRole === "member") {
    type ProjectMember = { userId: string; permission: string; grantedBy: string; grantedAt: string };
    const filtered = orgProjects.filter((p) => {
      const members = (p.members as ProjectMember[]) || [];
      return members.some((m) => m.userId === userId);
    });
    return c.json(filtered);
  }

  return c.json(orgProjects);
});

/**
 * GET /orgs/:orgId/projects/:projectId
 * Get project details + its apps. Members must be assigned to the project.
 */
projectsRouter.get("/:projectId", async (c) => {
  const db = c.get("db");
  const projectId = c.req.param("projectId");
  const userId = c.get("userId");
  const userRole = c.get("userRole");

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  // Members must be assigned to this project
  if (userRole === "member") {
    type ProjectMember = { userId: string; permission: string; grantedBy: string; grantedAt: string };
    const members = (project.members as ProjectMember[]) || [];
    if (!members.some((m) => m.userId === userId)) {
      return c.json({ error: "Forbidden" }, 403);
    }
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
  const body = await c.req.json<{ name?: string; slug?: string; description?: string; icon?: string; designSystem?: Record<string, unknown> }>();

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
