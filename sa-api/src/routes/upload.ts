import { Hono } from "hono";
import type { Env, AppVariables } from "../types";
import { authMiddleware, adminOnly } from "../middleware/auth";

const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/gif"];
const MAX_SIZE = 2 * 1024 * 1024; // 2MB

const uploadRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

uploadRouter.use("*", authMiddleware, adminOnly);

/**
 * POST /upload/icon
 * Upload an icon image to R2.
 *
 * Expects multipart/form-data with:
 *   - file: the image file
 *   - entity: "org" | "project" | "app"
 *   - entityId: the UUID of the entity
 *
 * Returns: { url: string }
 */
uploadRouter.post("/icon", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file");
  const entity = formData.get("entity") as string | null;
  const entityId = formData.get("entityId") as string | null;

  if (!file || !(file instanceof File)) {
    return c.json({ error: "No file provided" }, 400);
  }
  if (!entity || !["org", "project", "app"].includes(entity)) {
    return c.json({ error: 'entity must be "org", "project", or "app"' }, 400);
  }
  if (!entityId) {
    return c.json({ error: "entityId is required" }, 400);
  }

  // Validate file type
  if (!ALLOWED_TYPES.includes(file.type)) {
    return c.json({ error: `Unsupported file type: ${file.type}. Allowed: ${ALLOWED_TYPES.join(", ")}` }, 400);
  }

  // Validate file size
  if (file.size > MAX_SIZE) {
    return c.json({ error: `File too large. Max size: ${MAX_SIZE / 1024 / 1024}MB` }, 400);
  }

  // Determine file extension
  const ext = file.name?.split(".").pop()?.toLowerCase() || "png";
  const key = `${entity}s/${entityId}/icon.${ext}`;

  // Upload to R2
  await c.env.R2_BUCKET.put(key, file.stream(), {
    httpMetadata: {
      contentType: file.type,
      cacheControl: "public, max-age=31536000, immutable",
    },
  });

  // Return the public URL using the configured R2 public domain
  const baseUrl = c.env.R2_PUBLIC_URL || "https://sa-assets.superatom.ai";
  const url = `${baseUrl}/${key}`;

  return c.json({ url }, 201);
});

/**
 * DELETE /upload/icon
 * Delete an icon from R2.
 *
 * Expects JSON body: { entity, entityId }
 */
uploadRouter.delete("/icon", async (c) => {
  const { entity, entityId } = await c.req.json<{ entity: string; entityId: string }>();

  if (!entity || !["org", "project", "app"].includes(entity)) {
    return c.json({ error: 'entity must be "org", "project", or "app"' }, 400);
  }
  if (!entityId) {
    return c.json({ error: "entityId is required" }, 400);
  }

  // List and delete all icon files for this entity (handles extension changes)
  const prefix = `${entity}s/${entityId}/icon.`;
  const listed = await c.env.R2_BUCKET.list({ prefix });

  for (const obj of listed.objects) {
    await c.env.R2_BUCKET.delete(obj.key);
  }

  return c.json({ message: "Icon deleted" });
});

export default uploadRouter;
