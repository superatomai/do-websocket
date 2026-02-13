import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { organizations } from "../db/schema";
import type { Env, AppVariables } from "../types";
import { authMiddleware, adminOnly } from "../middleware/auth";

const orgs = new Hono<{ Bindings: Env; Variables: AppVariables }>();

orgs.use("*", authMiddleware, adminOnly);

/**
 * POST /orgs
 * Create organization
 */
orgs.post("/", async (c) => {
  const db = c.get("db");
  const { name, slug, icon } = await c.req.json<{ name: string; slug: string; icon?: string }>();

  if (!name || !slug) {
    return c.json({ error: "name and slug are required" }, 400);
  }

  const [org] = await db
    .insert(organizations)
    .values({ name, slug, icon })
    .returning();

  return c.json(org, 201);
});

/**
 * GET /orgs/:orgId
 * Get organization details
 */
orgs.get("/:orgId", async (c) => {
  const db = c.get("db");
  const orgId = c.req.param("orgId");

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  return c.json(org);
});

/**
 * PUT /orgs/:orgId
 * Update organization
 */
orgs.put("/:orgId", async (c) => {
  const db = c.get("db");
  const orgId = c.req.param("orgId");
  const body = await c.req.json<{ name?: string; slug?: string; icon?: string }>();

  const [updated] = await db
    .update(organizations)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(organizations.id, orgId))
    .returning();

  if (!updated) {
    return c.json({ error: "Organization not found" }, 404);
  }

  return c.json(updated);
});

export default orgs;
