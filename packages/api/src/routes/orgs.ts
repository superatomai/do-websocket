import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { organizations, users } from "../db/schema";
import type { Env, AppVariables } from "../types";
import { authMiddleware, adminOnly, superAdminOnly, orgScopeGuard } from "../middleware/auth";
import { validatePassword } from "../lib/password-policy";

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
    const pwError = validatePassword(admin.password);
    if (pwError) {
      return c.json({ error: pwError }, 400);
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

  // Explicit allowlist rather than spreading the body: a spread lets a caller
  // set any column on `organizations`, including `id` and `createdAt`. Unknown
  // keys are ignored, so a column added later is not exposed by default.
  const updates: {
    name?: string;
    slug?: string;
    icon?: string;
    defaultAppId?: string | null;
    updatedAt: Date;
  } = { updatedAt: new Date() };

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 255) {
      return c.json({ error: "Invalid name" }, 400);
    }
    updates.name = body.name;
  }
  if (body.slug !== undefined) {
    if (typeof body.slug !== "string" || !body.slug.trim() || body.slug.length > 100) {
      return c.json({ error: "Invalid slug" }, 400);
    }
    updates.slug = body.slug;
  }
  if (body.icon !== undefined) {
    if (typeof body.icon !== "string") return c.json({ error: "Invalid icon" }, 400);
    updates.icon = body.icon;
  }
  if (body.defaultAppId !== undefined) {
    if (body.defaultAppId !== null && typeof body.defaultAppId !== "string") {
      return c.json({ error: "Invalid defaultAppId" }, 400);
    }
    updates.defaultAppId = body.defaultAppId;
  }

  const [updated] = await db
    .update(organizations)
    .set(updates)
    .where(eq(organizations.id, orgId))
    .returning();

  if (!updated) {
    return c.json({ error: "Organization not found" }, 404);
  }

  return c.json(updated);
});

export default orgs;
