import { Hono } from "hono";
import { desc } from "drizzle-orm";
import { productFeedback } from "../db/schema";
import type { Env, AppVariables } from "../types";
import { authMiddleware, superAdminOnly } from "../middleware/auth";

const feedbackRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/**
 * POST /feedback
 * Create product feedback (authenticated via JWT from sa-platform-ui)
 *
 * Requires JWT authentication. Identity (orgId, userId) is extracted from the
 * verified JWT token and cannot be spoofed. Frontend sends only the feedback
 * content (message, category, pageContext).
 */
feedbackRouter.post("/", authMiddleware, async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const orgId = c.get("orgId");

  const payload = await c.req.json<{
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
      orgId: orgId || null,
      userId: userId || null,
      category: payload.category || null,
      message: payload.message,
      pageContext: payload.pageContext || null,
    })
    .returning();

  // Format timestamp to ISO string to preserve timezone info
  const formattedInserted = {
    ...inserted,
    createdAt: inserted.createdAt.toISOString(),
  };

  return c.json(formattedInserted, 201);
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

  // Format timestamps to ISO strings to preserve timezone info
  const formattedRows = rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }));

  return c.json(formattedRows, 200);
});

export default feedbackRouter;
