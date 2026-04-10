import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { SignJWT } from "jose";
import { users, organizations, projects } from "../db/schema";
import type { Env, AppVariables } from "../types";
import { authMiddleware } from "../middleware/auth";

const auth = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/**
 * POST /auth/login
 * Login with email/password, returns JWT
 */
auth.post("/login", async (c) => {
  const db = c.get("db");
  const { email, username, password } = await c.req.json<{
    email?: string;
    username?: string;
    password: string;
  }>();

  if ((!email && !username) || !password) {
    return c.json({ error: "Email or username, and password are required" }, 400);
  }

  // Find user by email or username
  const identifier = email
    ? eq(users.email, email)
    : eq(users.username, username!);

  const [user] = await db
    .select()
    .from(users)
    .where(and(identifier, eq(users.isActive, true)))
    .limit(1);

  if (!user) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  // Verify password using Web Crypto (SHA-256 hash comparison)
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (hashHex !== user.passwordHash) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  // Sign JWT
  const secret = new TextEncoder().encode(c.env.JWT_SECRET);
  const token = await new SignJWT({
    userId: user.id,
    orgId: user.orgId,
    role: user.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret);

  return c.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      name: user.name,
      role: user.role,
      orgId: user.orgId,
    },
  });
});

/**
 * POST /auth/logout
 * Client-side logout — just acknowledge (JWT is stateless)
 */
auth.post("/logout", authMiddleware, async (c) => {
  return c.json({ message: "Logged out successfully" });
});

/**
 * GET /auth/me
 * Get current user + org + list of permitted apps
 */
auth.get("/me", authMiddleware, async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  // Super admin: no org, no projects
  if (user.role === "super_admin") {
    return c.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        name: user.name,
        role: user.role,
      },
      organization: null,
      projects: [],
    });
  }

  const [org] = user.orgId
    ? await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, user.orgId))
        .limit(1)
    : [null];

  // Get accessible projects
  type ProjectMember = { userId: string; permission: string; grantedBy: string; grantedAt: string };
  let accessibleProjects;

  const orgProjects = await db
    .select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      description: projects.description,
      icon: projects.icon,
      members: projects.members,
    })
    .from(projects)
    .where(eq(projects.orgId, user.orgId!));

  if (user.role === "org_admin") {
    // Admin sees all projects in the org
    accessibleProjects = orgProjects;
  } else {
    // Member sees only projects they're assigned to
    accessibleProjects = orgProjects.filter((p) => {
      const members = (p.members as ProjectMember[]) || [];
      return members.some((m) => m.userId === userId);
    });
  }

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      name: user.name,
      role: user.role,
    },
    organization: org
      ? { id: org.id, name: org.name, slug: org.slug, icon: org.icon }
      : null,
    projects: accessibleProjects,
  });
});

export default auth;
