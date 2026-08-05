import { Hono } from "hono";
import { answerFeedback } from "../db/schema";
import type { Env, AppVariables } from "../types";

const answerFeedbackRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/**
 * POST /answer-feedback
 * Create answer feedback (server-to-server from backend, authenticated via service token)
 *
 * Receives dual-write from backend collection after local insert succeeds.
 * Central mirror of local answer_feedback table in superatom-setup-code.
 */
answerFeedbackRouter.post("/", async (c) => {
  const db = c.get("db");

  // Verify service token
  const serviceToken = c.req.header("X-SA-Service-Token");
  const expectedToken = c.env.SA_INTERNAL_SERVICE_TOKEN;

  if (!serviceToken || serviceToken !== expectedToken) {
    return c.json({ error: "Unauthorized: invalid or missing service token" }, 401);
  }

  const payload = await c.req.json<{
    orgId?: string;
    projectId?: string;
    userId?: string;
    uiBlockId: string;
    userPrompt: string;
    isCorrect: boolean;
    feedbackText?: string;
    answerSnapshot?: unknown;
  }>();

  if (!payload.uiBlockId || typeof payload.isCorrect !== "boolean" || !payload.userPrompt) {
    return c.json(
      { error: "uiBlockId, isCorrect, and userPrompt are required" },
      400
    );
  }

  const [inserted] = await db
    .insert(answerFeedback)
    .values({
      orgId: payload.orgId || null,
      projectId: payload.projectId || null,
      userId: payload.userId || null,
      uiBlockId: payload.uiBlockId,
      userPrompt: payload.userPrompt,
      isCorrect: payload.isCorrect,
      feedbackText: payload.feedbackText || null,
      answerSnapshot: payload.answerSnapshot || null,
    })
    .returning();

  return c.json(inserted, 201);
});

export default answerFeedbackRouter;
