import { Hono } from "hono";
import { cors } from "hono/cors";
import { createDb } from "./db";
import type { Env, AppVariables } from "./types";

import authRoutes from "./routes/auth";
import ssoRoutes from "./routes/sso";
import bootstrapRoutes from "./routes/bootstrap";
import orgRoutes from "./routes/orgs";
import usersRoutes from "./routes/users";
import projectsRoutes from "./routes/projects";
import appsRoutes from "./routes/apps";
import permissionsRoutes from "./routes/permissions";
import myAppsRoutes from "./routes/my-apps";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// ─── CORS ────────────────────────────────────────────────
app.use("*", cors());

// ─── Inject DB into context ──────────────────────────────
app.use("*", async (c, next) => {
  const db = createDb(c.env.DATABASE_URL);
  c.set("db", db);
  await next();
});

// ─── Health check ────────────────────────────────────────
app.get("/health", (c) =>
  c.json({
    status: "healthy",
    worker: "sa-api",
    timestamp: Date.now(),
  })
);

// ─── Routes ──────────────────────────────────────────────
app.route("/auth", authRoutes);
app.route("/auth/sso", ssoRoutes);
app.route("/auth", bootstrapRoutes);
app.route("/orgs", orgRoutes);
app.route("/orgs/:orgId/users", usersRoutes);
app.route("/orgs/:orgId/projects", projectsRoutes);
app.route("/my/apps", myAppsRoutes); // must be before appsRoutes (mounted at /) to avoid adminOnly middleware
app.route("/apps", permissionsRoutes); // handles /apps/:appId/permissions
app.route("/", appsRoutes); // handles /projects/:projectId/apps and /apps/:appId

// ─── 404 fallback ────────────────────────────────────────
app.notFound((c) =>
  c.json({ error: "Not found", path: c.req.path }, 404)
);

// ─── Error handler ───────────────────────────────────────
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
