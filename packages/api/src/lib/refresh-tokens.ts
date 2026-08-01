/**
 * Rotating refresh tokens with reuse detection.
 *
 * Access tokens are short-lived and stateless. Refreshing them needs server
 * state because a stateless token cannot be revoked, so each refresh token is a
 * row: presenting one consumes it and issues a replacement in the same family.
 *
 * The token is opaque, not a JWT: `<rowId>.<secret>`. The id makes lookup a
 * primary-key hit rather than a table scan, and only the SHA-256 of the secret
 * is stored, so a database leak yields no usable tokens.
 */

import { eq, and, isNull } from "drizzle-orm";
import { refreshTokens } from "../db/schema";

/** 30 days. Long-lived by design — the ACCESS token is the short one. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Grace period after rotation during which the old token is still accepted.
 *
 * Without this, two browser tabs refreshing at the same moment would have the
 * second one look like a stolen token, trip reuse detection, and sign the user
 * out everywhere. That is the classic way refresh rotation ships broken. A short
 * window costs little — the token is already single-use past 60 seconds — and it
 * needs no cross-tab coordination in the client.
 */
const ROTATION_GRACE_MS = 60 * 1000;

export type RotateResult =
  | { ok: true; userId: string; token: string }
  | { ok: false; reason: "invalid" | "expired" | "revoked" | "reuse_detected" };

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Length-independent comparison, so a mismatch position is not observable. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Mint a refresh token. Omit `familyId` to start a new family (a fresh login);
 * pass one to continue an existing chain (a rotation).
 */
export async function issueRefreshToken(
  db: any,
  userId: string,
  options: { familyId?: string; userAgent?: string | null } = {}
): Promise<{ token: string; id: string; familyId: string }> {
  const secret = randomSecret();
  const familyId = options.familyId ?? crypto.randomUUID();

  const [row] = await db
    .insert(refreshTokens)
    .values({
      userId,
      familyId,
      tokenHash: await sha256Hex(secret),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      userAgent: options.userAgent?.slice(0, 500) ?? null,
    })
    .returning({ id: refreshTokens.id });

  return { token: `${row.id}.${secret}`, id: row.id, familyId };
}

/** Revoke every unrevoked token in a family — used on reuse detection. */
export async function revokeFamily(db: any, familyId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
}

/** Revoke every session for a user — used on logout. */
export async function revokeAllForUser(db: any, userId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}

/**
 * Validate a refresh token and exchange it for a new one.
 *
 * Returns `reuse_detected` when an already-rotated token is presented past the
 * grace window: two parties hold it, so the entire family is revoked and
 * everyone re-authenticates. This does not prevent theft — it makes theft
 * self-limiting and detectable, which a long-lived bearer token never is.
 */
export async function rotateRefreshToken(
  db: any,
  rawToken: string,
  userAgent?: string | null
): Promise<RotateResult> {
  const separator = rawToken.indexOf(".");
  if (separator <= 0) return { ok: false, reason: "invalid" };

  const id = rawToken.slice(0, separator);
  const secret = rawToken.slice(separator + 1);
  if (!id || !secret) return { ok: false, reason: "invalid" };

  let row: any;
  try {
    [row] = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.id, id))
      .limit(1);
  } catch {
    // A malformed id is not a valid UUID and Postgres rejects the comparison.
    return { ok: false, reason: "invalid" };
  }

  if (!row) return { ok: false, reason: "invalid" };

  // Compare before any other check so a wrong secret cannot probe token state.
  if (!timingSafeEqual(await sha256Hex(secret), row.tokenHash)) {
    return { ok: false, reason: "invalid" };
  }

  if (row.revokedAt) return { ok: false, reason: "revoked" };
  if (new Date(row.expiresAt).getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
  }

  if (row.rotatedAt) {
    const since = Date.now() - new Date(row.rotatedAt).getTime();
    if (since > ROTATION_GRACE_MS) {
      await revokeFamily(db, row.familyId);
      console.warn(
        `[auth] refresh token reuse detected: user=${row.userId} family=${row.familyId} — family revoked`
      );
      return { ok: false, reason: "reuse_detected" };
    }
    // Inside the grace window: a concurrent tab, not an attacker. Fall through
    // and issue another token in the same family rather than revoking.
  }

  const next = await issueRefreshToken(db, row.userId, {
    familyId: row.familyId,
    userAgent,
  });

  await db
    .update(refreshTokens)
    .set({ rotatedAt: new Date(), replacedById: next.id })
    .where(eq(refreshTokens.id, row.id));

  return { ok: true, userId: row.userId, token: next.token };
}
