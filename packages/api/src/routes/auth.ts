import { Hono } from "hono";
import { eq, and, inArray } from "drizzle-orm";
import { SignJWT } from "jose";
import { users, organizations, appPermissions, apps, projects } from "../db/schema";
import type { Env, AppVariables } from "../types";
import { authMiddleware } from "../middleware/auth";

const auth = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/**
 * POST /auth/login
 * Login with email/password, returns JWT
 */
auth.post("/login", async (c) => {
  const db = c.get("db");
  const { email, username, password, orgSlug } = await c.req.json<{
    email?: string;
    username?: string;
    password: string;
    orgSlug?: string;
  }>();

  if ((!email && !username) || !password) {
    return c.json({ error: "Email or username, and password are required" }, 400);
  }

  // Hash the incoming password once for comparison
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(password));
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  let matchedUsers: (typeof users.$inferSelect)[] = [];

  if (email && orgSlug) {
    // Org-scoped lookup — email is unique per org
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, orgSlug))
      .limit(1);
    if (!org) return c.json({ error: "Organization not found" }, 404);

    const [found] = await db
      .select()
      .from(users)
      .where(and(eq(users.email, email), eq(users.orgId, org.id), eq(users.isActive, true)))
      .limit(1);
    if (found) matchedUsers = [found];
  } else if (email) {
    // No org context — find all active users with this email across orgs
    matchedUsers = await db
      .select()
      .from(users)
      .where(and(eq(users.email, email), eq(users.isActive, true)));
  } else {
    // Username is globally unique
    const [found] = await db
      .select()
      .from(users)
      .where(and(eq(users.username, username!), eq(users.isActive, true)))
      .limit(1);
    if (found) matchedUsers = [found];
  }

  // Filter to users whose password matches
  const validUsers = matchedUsers.filter((u) => u.passwordHash === hashHex);

  if (validUsers.length === 0) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  // Log into the first matched user; also return all their orgs
  const user = validUsers[0];

  const allOrgIds = validUsers.map((u) => u.orgId).filter(Boolean) as string[];
  const orgs = allOrgIds.length
    ? await db
        .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
        .from(organizations)
        .where(inArray(organizations.id, allOrgIds))
    : [];

  // Sign JWT for the first matched user
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
    orgs,
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

  // Super admin: no org, no app list
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
      apps: [],
    });
  }

  const [org] = user.orgId
    ? await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, user.orgId))
        .limit(1)
    : [null];

  // Get permitted apps
  let permittedApps;
  if (user.role === "org_admin") {
    // Admin sees all active apps in the org
    permittedApps = await db
      .select({
        id: apps.id,
        name: apps.name,
        type: apps.type,
        projectId: apps.projectId,
        projectName: projects.name,
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
      .where(and(eq(projects.orgId, user.orgId!), eq(apps.isActive, true)));
  } else {
    // Member sees explicitly permitted apps + org's default app
    permittedApps = await db
      .select({
        id: apps.id,
        name: apps.name,
        type: apps.type,
        projectId: apps.projectId,
        projectName: projects.name,
        permission: appPermissions.permission,
      })
      .from(appPermissions)
      .innerJoin(apps, eq(apps.id, appPermissions.appId))
      .innerJoin(projects, eq(projects.id, apps.projectId))
      .where(
        and(eq(appPermissions.userId, userId), eq(apps.isActive, true))
      );

    // Include org's default app if not already in the list
    if (org?.defaultAppId && !permittedApps.find((a) => a.id === org.defaultAppId)) {
      const [defaultApp] = await db
        .select({
          id: apps.id,
          name: apps.name,
          type: apps.type,
          projectId: apps.projectId,
          projectName: projects.name,
        })
        .from(apps)
        .innerJoin(projects, eq(projects.id, apps.projectId))
        .where(and(eq(apps.id, org.defaultAppId), eq(apps.isActive, true)))
        .limit(1);

      if (defaultApp) {
        permittedApps.unshift({ ...defaultApp, permission: "view" });
      }
    }
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
      ? { id: org.id, name: org.name, slug: org.slug, icon: org.icon, defaultAppId: org.defaultAppId }
      : null,
    apps: permittedApps,
  });
});

export default auth;
