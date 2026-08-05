import { Hono } from "hono";
import { desc } from "drizzle-orm";
import { productFeedback } from "../db/schema";
import type { Env, AppVariables } from "../types";
import { authMiddleware, superAdminOnly } from "../middleware/auth";

const feedbackRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/**
 * POST /feedback
 * Create product feedback (unauthenticated, from browser)
 *
 * Accepts feedback from any user about the product. Identity is optional
 * and sent from the runtime if available.
 */
feedbackRouter.post("/", async (c) => {
  const db = c.get("db");

  const payload = await c.req.json<{
    orgId?: string;
    userId?: string;
    category?: string;
    message: string;
    pageContext?: string;
  }>();

  if (!payload.message || payload.message.trim().length === 0) {
    return c.json({ error: "message is required" }, 400);
  }

  const [inserted] = await db
    .insert(productFeedback)
    .values({
      orgId: payload.orgId || null,
      userId: payload.userId || null,
      category: payload.category || null,
      message: payload.message,
      pageContext: payload.pageContext || null,
    })
    .returning();

  return c.json(inserted, 201);
});

/**
 * GET /feedback
 * List all product feedback (staff-only, authenticated via JWT)
 *
 * Requires super_admin role.
 */
feedbackRouter.get("/", authMiddleware, superAdminOnly, async (c) => {
  const db = c.get("db");

  const rows = await db
    .select()
    .from(productFeedback)
    .orderBy(desc(productFeedback.createdAt))
    .limit(200);

  return c.json(rows, 200);
});

export default feedbackRouter;
