import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { users } from "../db/schema";
import type { Env, AppVariables } from "../types";

const bootstrap = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/**
 * POST /auth/bootstrap
 * Creates the super_admin user (no org).
 * Only works if no super_admin exists in the database yet.
 *
 * Body: { email, name, password }
 */
bootstrap.post("/bootstrap", async (c) => {
  const db = c.get("db");

  // Check if a super_admin already exists
  const existingSuperAdmin = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, "super_admin"))
    .limit(1);

  if (existingSuperAdmin.length > 0) {
    return c.json({ error: "System is already bootstrapped. Super admin exists." }, 409);
  }

  const body = await c.req.json<{
    email: string;
    name: string;
    password: string;
  }>();

  if (!body.email || !body.name || !body.password) {
    return c.json({ error: "email, name, and password are all required" }, 400);
  }

  if (body.password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
  }

  // Hash password using SHA-256 (Web Crypto API — compatible with Cloudflare Workers)
  const encoder = new TextEncoder();
  const data = encoder.encode(body.password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const passwordHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Create super_admin user (no org)
  const [admin] = await db
    .insert(users)
    .values({
      orgId: null,
      email: body.email,
      name: body.name,
      passwordHash,
      role: "super_admin",
      isActive: true,
    })
    .returning({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
    });

  return c.json(
    {
      message: "System bootstrapped successfully. Super admin created.",
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
      },
    },
    201
  );
});

export default bootstrap;
