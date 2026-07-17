import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { organizations, users } from "../db/schema";
import type { Env, AppVariables } from "../types";
import { authMiddleware, adminOnly, superAdminOnly, orgScopeGuard } from "../middleware/auth";

const orgs = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/**
 * Hash a password using SHA-256
 */
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * POST /orgs
 * Create organization (super_admin only).
 * Optionally creates an org_admin user in the same call.
 */
orgs.post("/", authMiddleware, superAdminOnly, async (c) => {
  const db = c.get("db");
  const { name, slug, icon, admin } = await c.req.json<{
    name: string;
    slug: string;
    icon?: string;
    admin?: {
      email: string;
      name: string;
      password: string;
    };
  }>();

  if (!name || !slug) {
    return c.json({ error: "name and slug are required" }, 400);
  }

  // Check slug uniqueness
  const [existingOrg] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, slug))
    .limit(1);

  if (existingOrg) {
    return c.json({ error: "An organization with this slug already exists" }, 409);
  }

  // Create org
  const [org] = await db
    .insert(organizations)
    .values({ name, slug, icon })
    .returning();

  let orgAdmin = null;

  // Optionally create org_admin
  if (admin) {
    if (!admin.email || !admin.name || !admin.password) {
      return c.json({ error: "admin.email, admin.name, and admin.password are required" }, 400);
    }
    if (admin.password.length < 8) {
      return c.json({ error: "Admin password must be at least 8 characters" }, 400);
    }

    const passwordHash = await hashPassword(admin.password);

    const [adminUser] = await db
      .insert(users)
      .values({
        orgId: org.id,
        email: admin.email,
        name: admin.name,
        passwordHash,
        role: "org_admin",
        isActive: true,
      })
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
      });

    orgAdmin = adminUser;
  }

  return c.json({ organization: org, admin: orgAdmin }, 201);
});

/**
 * GET /orgs
 * List all organizations (super_admin only).
 */
orgs.get("/", authMiddleware, superAdminOnly, async (c) => {
  const db = c.get("db");
  const allOrgs = await db.select().from(organizations);
  return c.json(allOrgs);
});

/**
 * GET /orgs/:orgId
 * Get organization details (admin of that org, or super_admin).
 */
orgs.get("/:orgId", authMiddleware, adminOnly, orgScopeGuard, async (c) => {
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
 * Update organization (admin of that org, or super_admin).
 */
orgs.put("/:orgId", authMiddleware, adminOnly, orgScopeGuard, async (c) => {
  const db = c.get("db");
  const orgId = c.req.param("orgId");
  const body = await c.req.json<{ name?: string; slug?: string; icon?: string; defaultAppId?: string | null }>();

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
