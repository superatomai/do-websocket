import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { SignJWT, jwtVerify, createRemoteJWKSet } from "jose";
import { users, organizations, ssoConfigs } from "../db/schema";
import type { Env, AppVariables } from "../types";
import { authMiddleware, adminOnly } from "../middleware/auth";

const sso = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// ─── Types ──────────────────────────────────────────────

interface OIDCDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri: string;
  issuer: string;
}

interface OIDCTokenResponse {
  access_token: string;
  id_token: string;
  token_type: string;
  expires_in?: number;
}

// ─── Helpers ────────────────────────────────────────────

/**
 * Fetch OIDC discovery document from the issuer's well-known endpoint.
 */
async function fetchDiscovery(issuerUrl: string): Promise<OIDCDiscovery> {
  const url = issuerUrl.replace(/\/+$/, "") + "/.well-known/openid-configuration";
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch OIDC discovery from ${url}: ${res.status}`);
  }
  return res.json();
}

/**
 * Generate a signed state JWT containing orgId, nonce, and optional redirectTo.
 * Used to maintain state across the OIDC redirect flow (stateless Workers).
 */
async function createStateToken(
  orgId: string,
  nonce: string,
  jwtSecret: string,
  redirectTo?: string
): Promise<string> {
  const secret = new TextEncoder().encode(jwtSecret);
  const claims: Record<string, string> = { orgId, nonce };
  if (redirectTo) {
    claims.redirectTo = redirectTo;
  }
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(secret);
}

/**
 * Verify and decode the state JWT.
 */
async function verifyStateToken(
  state: string,
  jwtSecret: string
): Promise<{ orgId: string; nonce: string; redirectTo?: string }> {
  const secret = new TextEncoder().encode(jwtSecret);
  const { payload } = await jwtVerify(state, secret);
  return {
    orgId: payload.orgId as string,
    nonce: payload.nonce as string,
    redirectTo: payload.redirectTo as string | undefined,
  };
}

/**
 * Generate a random string for use as a nonce.
 */
function generateNonce(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Hash a password using SHA-256 (Web Crypto API).
 */
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Public SSO Endpoints ───────────────────────────────

/**
 * GET /auth/sso/authorize?org_slug=acme&redirect_to=https://app.example.com/sso-callback
 * Initiates the OIDC authorization code flow.
 * Redirects the browser to the enterprise IdP login page.
 *
 * @param org_slug - The organization's slug (required)
 * @param redirect_to - The frontend URL to redirect to after SSO (optional, falls back to PLATFORM_UI_URL)
 */
sso.get("/authorize", async (c) => {
  const db = c.get("db");
  const orgSlug = c.req.query("org_slug");
  const redirectTo = c.req.query("redirect_to");

  if (!orgSlug) {
    return c.json({ error: "org_slug query parameter is required" }, 400);
  }

  // Look up org by slug
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.slug, orgSlug))
    .limit(1);

  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  // Look up SSO config for this org
  const [config] = await db
    .select()
    .from(ssoConfigs)
    .where(and(eq(ssoConfigs.orgId, org.id), eq(ssoConfigs.isActive, true)))
    .limit(1);

  if (!config) {
    return c.json({ error: "SSO is not configured for this organization" }, 404);
  }

  // Fetch OIDC discovery
  const discovery = await fetchDiscovery(config.issuerUrl);

  // Generate state and nonce (embed redirectTo in state so we know where to send the user back)
  const nonce = generateNonce();
  const state = await createStateToken(org.id, nonce, c.env.JWT_SECRET, redirectTo);

  // Build the callback URL (points back to this SA-API worker)
  const callbackUrl = new URL(c.req.url);
  callbackUrl.pathname = "/auth/sso/callback";
  callbackUrl.search = "";

  // Build authorization URL
  const authUrl = new URL(discovery.authorization_endpoint);
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("redirect_uri", callbackUrl.toString());
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", config.scopes || "openid email profile");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("nonce", nonce);

  return c.redirect(authUrl.toString());
});

/**
 * GET /auth/sso/callback?code=...&state=...
 * Handles the IdP redirect after user authentication.
 * Exchanges the authorization code for tokens, creates/matches user, issues JWT.
 */
sso.get("/callback", async (c) => {
  const db = c.get("db");
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");
  const errorDescription = c.req.query("error_description");

  // Default fallback URL if no redirect_to was provided in the authorize step
  const fallbackUrl = c.env.PLATFORM_UI_URL || "http://localhost:5173";

  // Handle IdP errors (state may not be verifiable here, so use fallback)
  if (error) {
    const msg = errorDescription || error;
    return c.redirect(`${fallbackUrl}/sso-callback?error=${encodeURIComponent(msg)}`);
  }

  if (!code || !state) {
    return c.redirect(`${fallbackUrl}/sso-callback?error=${encodeURIComponent("Missing code or state parameter")}`);
  }

  try {
    // Verify state token to recover orgId, nonce, and redirectTo
    const { orgId, nonce, redirectTo } = await verifyStateToken(state, c.env.JWT_SECRET);

    // Use the redirect URL from the state token, or fall back to PLATFORM_UI_URL + /sso-callback
    const frontendCallbackUrl = redirectTo || `${fallbackUrl}/sso-callback`;

    // Look up SSO config for this org
    const [config] = await db
      .select()
      .from(ssoConfigs)
      .where(and(eq(ssoConfigs.orgId, orgId), eq(ssoConfigs.isActive, true)))
      .limit(1);

    if (!config) {
      return c.redirect(`${frontendCallbackUrl}?error=${encodeURIComponent("SSO configuration not found")}`);
    }

    // Fetch OIDC discovery
    const discovery = await fetchDiscovery(config.issuerUrl);

    // Build callback URL (same as in /authorize)
    const callbackUrl = new URL(c.req.url);
    callbackUrl.pathname = "/auth/sso/callback";
    callbackUrl.search = "";

    // Exchange code for tokens
    const tokenRes = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: callbackUrl.toString(),
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      console.error("[SSO] Token exchange failed:", errBody);
      console.error("[SSO] redirect_uri used:", callbackUrl.toString());
      return c.redirect(`${frontendCallbackUrl}?error=${encodeURIComponent("Token exchange failed: " + errBody)}`);
    }

    const tokens: OIDCTokenResponse = await tokenRes.json();

    // Validate the id_token using the IdP's JWKS
    const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
    const { payload: idToken } = await jwtVerify(tokens.id_token, jwks, {
      issuer: discovery.issuer,
      audience: config.clientId,
    });

    // Verify nonce
    if (idToken.nonce !== nonce) {
      return c.redirect(`${frontendCallbackUrl}?error=${encodeURIComponent("Invalid nonce")}`);
    }

    // Extract user identity from id_token
    const sub = idToken.sub as string;
    const email = (idToken.email as string) || "";
    const name =
      (idToken.name as string) ||
      `${idToken.given_name || ""} ${idToken.family_name || ""}`.trim() ||
      email.split("@")[0];

    if (!sub || !email) {
      return c.redirect(`${frontendCallbackUrl}?error=${encodeURIComponent("IdP did not return email or subject")}`);
    }

    // Find or create user
    // First try by ssoSubject + orgId
    let [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.orgId, orgId), eq(users.ssoSubject, sub)))
      .limit(1);

    if (!user) {
      // Try by email
      [user] = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (user) {
        // Existing user — link their SSO subject
        await db
          .update(users)
          .set({ ssoSubject: sub, updatedAt: new Date() })
          .where(eq(users.id, user.id));
      } else {
        // New user — auto-provision
        const [newUser] = await db
          .insert(users)
          .values({
            orgId,
            email,
            name,
            ssoSubject: sub,
            role: "member",
            isActive: true,
          })
          .returning();
        user = newUser;
      }
    }

    if (!user.isActive) {
      return c.redirect(`${frontendCallbackUrl}?error=${encodeURIComponent("Account is deactivated")}`);
    }

    // Issue SA-API JWT
    const secret = new TextEncoder().encode(c.env.JWT_SECRET);
    const saToken = await new SignJWT({
      userId: user.id,
      orgId: user.orgId,
      role: user.role,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("7d")
      .sign(secret);

    // Redirect to the frontend that initiated SSO with the token
    return c.redirect(`${frontendCallbackUrl}?token=${saToken}`);
  } catch (err: any) {
    console.error("[SSO] Callback error:", err);
    return c.redirect(`${fallbackUrl}/sso-callback?error=${encodeURIComponent("SSO authentication failed")}`);
  }
});

// ─── Admin SSO Config Endpoints ─────────────────────────

/**
 * GET /auth/sso/config
 * Get the SSO configuration for the current user's org.
 */
sso.get("/config", authMiddleware, adminOnly, async (c) => {
  const db = c.get("db");
  const orgId = c.get("orgId");
  if (!orgId) {
    return c.json({ error: "SSO config requires an organization context" }, 400);
  }

  const [config] = await db
    .select({
      id: ssoConfigs.id,
      provider: ssoConfigs.provider,
      clientId: ssoConfigs.clientId,
      issuerUrl: ssoConfigs.issuerUrl,
      scopes: ssoConfigs.scopes,
      isActive: ssoConfigs.isActive,
      createdAt: ssoConfigs.createdAt,
      updatedAt: ssoConfigs.updatedAt,
    })
    .from(ssoConfigs)
    .where(eq(ssoConfigs.orgId, orgId))
    .limit(1);

  if (!config) {
    return c.json({ configured: false }, 200);
  }

  return c.json({ configured: true, ...config });
});

/**
 * POST /auth/sso/config
 * Create or update SSO configuration for the current user's org.
 */
sso.post("/config", authMiddleware, adminOnly, async (c) => {
  const db = c.get("db");
  const orgId = c.get("orgId");
  if (!orgId) {
    return c.json({ error: "SSO config requires an organization context" }, 400);
  }
  const body = await c.req.json<{
    provider: "microsoft_entra" | "okta" | "generic_oidc";
    clientId: string;
    clientSecret: string;
    issuerUrl: string;
    scopes?: string;
  }>();

  if (!body.provider || !body.clientId || !body.clientSecret || !body.issuerUrl) {
    return c.json({ error: "provider, clientId, clientSecret, and issuerUrl are required" }, 400);
  }

  // Validate the issuer URL by fetching discovery
  try {
    await fetchDiscovery(body.issuerUrl);
  } catch {
    return c.json({ error: "Could not reach OIDC discovery endpoint at the provided issuerUrl" }, 400);
  }

  // Check if config already exists
  const [existing] = await db
    .select({ id: ssoConfigs.id })
    .from(ssoConfigs)
    .where(eq(ssoConfigs.orgId, orgId))
    .limit(1);

  if (existing) {
    // Update existing config
    const [updated] = await db
      .update(ssoConfigs)
      .set({
        provider: body.provider,
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        issuerUrl: body.issuerUrl,
        scopes: body.scopes || "openid email profile",
        isActive: true,
        updatedAt: new Date(),
      })
      .where(eq(ssoConfigs.id, existing.id))
      .returning({
        id: ssoConfigs.id,
        provider: ssoConfigs.provider,
        clientId: ssoConfigs.clientId,
        issuerUrl: ssoConfigs.issuerUrl,
        scopes: ssoConfigs.scopes,
        isActive: ssoConfigs.isActive,
      });

    return c.json({ message: "SSO configuration updated", ...updated });
  }

  // Create new config
  const [created] = await db
    .insert(ssoConfigs)
    .values({
      orgId,
      provider: body.provider,
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      issuerUrl: body.issuerUrl,
      scopes: body.scopes || "openid email profile",
    })
    .returning({
      id: ssoConfigs.id,
      provider: ssoConfigs.provider,
      clientId: ssoConfigs.clientId,
      issuerUrl: ssoConfigs.issuerUrl,
      scopes: ssoConfigs.scopes,
      isActive: ssoConfigs.isActive,
    });

  return c.json({ message: "SSO configuration created", ...created }, 201);
});

/**
 * DELETE /auth/sso/config
 * Remove SSO configuration for the current user's org.
 */
sso.delete("/config", authMiddleware, adminOnly, async (c) => {
  const db = c.get("db");
  const orgId = c.get("orgId");
  if (!orgId) {
    return c.json({ error: "SSO config requires an organization context" }, 400);
  }

  const result = await db
    .delete(ssoConfigs)
    .where(eq(ssoConfigs.orgId, orgId))
    .returning({ id: ssoConfigs.id });

  if (result.length === 0) {
    return c.json({ error: "No SSO configuration found" }, 404);
  }

  return c.json({ message: "SSO configuration deleted" });
});

export default sso;
