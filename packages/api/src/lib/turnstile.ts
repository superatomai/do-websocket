/**
 * Cloudflare Turnstile verification for the login form.
 *
 * Gated on TURNSTILE_SECRET_KEY. When the secret is not configured, verification
 * is skipped entirely — so the backend can ship before the front-ends send a
 * token, and enforcement is switched on later simply by setting the secret.
 * This mirrors the staged rollout used for the WebSocket auth gate.
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileEnv {
  TURNSTILE_SECRET_KEY?: string;
}

/**
 * Returns null when the request may proceed, or an error message to return as a
 * 400. Fails closed once a secret is configured: a missing or invalid token is
 * rejected. Fails open only when no secret is set (pre-rollout / dev).
 */
export async function verifyTurnstile(
  env: TurnstileEnv,
  token: string | undefined,
  remoteIp?: string
): Promise<string | null> {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) return null; // Not configured — skip.

  if (!token) return "Captcha verification is required.";

  const form = new URLSearchParams({ secret, response: token });
  if (remoteIp) form.set("remoteip", remoteIp);

  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success ? null : "Captcha verification failed.";
  } catch (err) {
    // A verification-service outage should not silently disable the control,
    // but it also should not be reported as a bad captcha. 503 lets the client
    // distinguish and retry.
    console.error("[turnstile] siteverify request failed:", err);
    return "Captcha verification is temporarily unavailable.";
  }
}
