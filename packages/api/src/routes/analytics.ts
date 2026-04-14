import { Hono } from "hono";
import { eq, and, sql, desc, gte, lte, count, sum, avg } from "drizzle-orm";
import { chatAnalytics } from "../db/schema";
import type { Env, AppVariables } from "../types";
import { authMiddleware, adminOnly } from "../middleware/auth";

const analyticsRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/**
 * POST /analytics/chat
 * Ingest a chat analytics event (called by the SDK server-to-server, no auth required)
 */
analyticsRouter.post("/analytics/chat", async (c) => {
  const db = c.get("db");
  const body = await c.req.json<{
    userId: string;
    orgId?: string;
    projectId: string;
    threadId: string;
    messageIndex: number;
    question: string;
    sourcesUsed?: { sourceId: string; sourceName: string; sourceType: string }[];
    sqlGenerated?: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cost: string; // numeric as string for precision
    latencyMs: number;
    status: "success" | "error";
    errorMessage?: string;
  }>();

  if (!body.userId || !body.projectId || !body.question || !body.model) {
    return c.json({ error: "userId, projectId, question, and model are required" }, 400);
  }

  const [event] = await db
    .insert(chatAnalytics)
    .values({
      userId: body.userId,
      orgId: body.orgId || null,
      projectId: body.projectId,
      threadId: body.threadId,
      messageIndex: body.messageIndex,
      question: body.question,
      sourcesUsed: body.sourcesUsed || null,
      sqlGenerated: body.sqlGenerated || null,
      model: body.model,
      inputTokens: body.inputTokens,
      outputTokens: body.outputTokens,
      cost: body.cost,
      latencyMs: body.latencyMs,
      status: body.status,
      errorMessage: body.errorMessage || null,
    })
    .returning({ id: chatAnalytics.id });

  return c.json({ success: true, id: event.id }, 201);
});

/**
 * PATCH /analytics/chat/:id/feedback
 * Update feedback for a chat analytics event (no auth — called from frontend via SDK)
 */
analyticsRouter.patch("/analytics/chat/:id/feedback", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const { feedback } = await c.req.json<{ feedback: "thumbs_up" | "thumbs_down" }>();

  if (!feedback || !["thumbs_up", "thumbs_down"].includes(feedback)) {
    return c.json({ error: "feedback must be 'thumbs_up' or 'thumbs_down'" }, 400);
  }

  const [updated] = await db
    .update(chatAnalytics)
    .set({ feedback })
    .where(eq(chatAnalytics.id, id))
    .returning({ id: chatAnalytics.id });

  if (!updated) {
    return c.json({ error: "Analytics event not found" }, 404);
  }

  return c.json({ success: true });
});

/**
 * GET /analytics/chat?orgId=&projectId=&from=&to=&userId=&limit=&offset=
 * Query chat analytics events (admin only)
 */
analyticsRouter.get("/analytics/chat", authMiddleware, adminOnly, async (c) => {
  const db = c.get("db");
  const orgId = c.req.query("orgId") || c.get("orgId");
  const projectId = c.req.query("projectId");
  const userId = c.req.query("userId");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const limit = Math.min(Number(c.req.query("limit") || 50), 200);
  const offset = Number(c.req.query("offset") || 0);

  const conditions = [];
  if (orgId) conditions.push(eq(chatAnalytics.orgId, orgId));
  if (projectId) conditions.push(eq(chatAnalytics.projectId, projectId));
  if (userId) conditions.push(eq(chatAnalytics.userId, userId));
  if (from) conditions.push(gte(chatAnalytics.createdAt, new Date(from)));
  if (to) conditions.push(lte(chatAnalytics.createdAt, new Date(to)));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const events = await db
    .select()
    .from(chatAnalytics)
    .where(where)
    .orderBy(desc(chatAnalytics.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json(events);
});

/**
 * GET /analytics/chat/summary?orgId=&projectId=&from=&to=
 * Aggregated summary: total queries, total cost, avg latency, model breakdown (admin only)
 */
analyticsRouter.get("/analytics/chat/summary", authMiddleware, adminOnly, async (c) => {
  const db = c.get("db");
  const orgId = c.req.query("orgId") || c.get("orgId");
  const projectId = c.req.query("projectId");
  const from = c.req.query("from");
  const to = c.req.query("to");

  const conditions = [];
  if (orgId) conditions.push(eq(chatAnalytics.orgId, orgId));
  if (projectId) conditions.push(eq(chatAnalytics.projectId, projectId));
  if (from) conditions.push(gte(chatAnalytics.createdAt, new Date(from)));
  if (to) conditions.push(lte(chatAnalytics.createdAt, new Date(to)));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // Overall summary
  const [overall] = await db
    .select({
      totalQueries: count(),
      totalCost: sum(chatAnalytics.cost),
      avgLatencyMs: avg(chatAnalytics.latencyMs),
      totalInputTokens: sum(chatAnalytics.inputTokens),
      totalOutputTokens: sum(chatAnalytics.outputTokens),
      successCount: count(
        sql`CASE WHEN ${chatAnalytics.status} = 'success' THEN 1 END`
      ),
      errorCount: count(
        sql`CASE WHEN ${chatAnalytics.status} = 'error' THEN 1 END`
      ),
      uniqueUsers: sql<number>`COUNT(DISTINCT ${chatAnalytics.userId})`,
    })
    .from(chatAnalytics)
    .where(where);

  // Per-model breakdown
  const modelBreakdown = await db
    .select({
      model: chatAnalytics.model,
      queryCount: count(),
      totalCost: sum(chatAnalytics.cost),
      avgLatencyMs: avg(chatAnalytics.latencyMs),
      totalInputTokens: sum(chatAnalytics.inputTokens),
      totalOutputTokens: sum(chatAnalytics.outputTokens),
    })
    .from(chatAnalytics)
    .where(where)
    .groupBy(chatAnalytics.model)
    .orderBy(desc(count()));

  // Per-user breakdown
  const userBreakdown = await db
    .select({
      userId: chatAnalytics.userId,
      queryCount: count(),
      totalCost: sum(chatAnalytics.cost),
      avgLatencyMs: avg(chatAnalytics.latencyMs),
    })
    .from(chatAnalytics)
    .where(where)
    .groupBy(chatAnalytics.userId)
    .orderBy(desc(count()))
    .limit(20);

  return c.json({
    overall,
    modelBreakdown,
    userBreakdown,
  });
});

export default analyticsRouter;
