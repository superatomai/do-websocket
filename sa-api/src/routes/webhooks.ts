import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { Webhook } from "svix";
import { organizations, users, appPermissions } from "../db/schema";
import type { Env, AppVariables } from "../types";

const webhooks = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// No auth middleware — Clerk calls this endpoint directly.
// We verify the request using the Svix webhook signature instead.

webhooks.post("/", async (c) => {
  const db = c.get("db");
  const secret = c.env.CLERK_WEBHOOK_SECRET;

  // ─── Verify webhook signature ───────────────────────────
  const svixId = c.req.header("svix-id");
  const svixTimestamp = c.req.header("svix-timestamp");
  const svixSignature = c.req.header("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    return c.json({ error: "Missing svix headers" }, 400);
  }

  const body = await c.req.text();

  let event: { type: string; data: Record<string, any> };
  try {
    const wh = new Webhook(secret);
    event = wh.verify(body, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as typeof event;
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return c.json({ error: "Invalid webhook signature" }, 400);
  }

  // ─── Route by event type ────────────────────────────────
  const { type, data } = event;
  console.log(`Clerk webhook received: ${type}`);

  switch (type) {
    case "user.created": {
      await handleUserCreated(db, data);
      break;
    }
    case "user.updated": {
      await handleUserUpdated(db, data);
      break;
    }
    case "organization.created": {
      await handleOrganizationCreated(db, data);
      break;
    }
    case "organizationMembership.created": {
      await handleMembershipCreated(db, data);
      break;
    }
    case "user.deleted": {
      await handleUserDeleted(db, data);
      break;
    }
    case "organization.deleted": {
      await handleOrganizationDeleted(db, data);
      break;
    }
    case "organizationMembership.updated": {
      await handleMembershipUpdated(db, data);
      break;
    }
    case "organizationMembership.deleted": {
      await handleMembershipDeleted(db, data);
      break;
    }
    case "organizationInvitation.created": {
      console.log("Organization invitation created:", data.id);
      break;
    }
    default: {
      console.log(`Unhandled webhook event: ${type}`);
    }
  }

  return c.json({ received: true });
});

// ─── Helpers ────────────────────────────────────────────────

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Event handlers ─────────────────────────────────────────

async function handleUserCreated(db: any, data: Record<string, any>) {
  const clerkId = data.id as string;
  const email =
    data.email_addresses?.find(
      (e: any) => e.id === data.primary_email_address_id
    )?.email_address ?? data.email_addresses?.[0]?.email_address;
  const name = [data.first_name, data.last_name].filter(Boolean).join(" ") || "Unknown";
  const username = data.username ?? null;

  if (!email) {
    console.error("user.created: no email found for clerk user", clerkId);
    return;
  }

  // Generate system password: clerkUserId + "_sa_secret"
  // Frontend uses the same formula after Clerk login to call SA-API /auth/login
  const systemPassword = `${clerkId}_sa_secret`;
  const passwordHash = await hashPassword(systemPassword);

  // Check if user already exists by clerkId
  const [existingByClerkId] = await db
    .select()
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);

  if (existingByClerkId) {
    console.log("user.created: user already exists", clerkId);
    return;
  }

  // Check if a deactivated user exists with the same email (re-signup)
  const [existingByEmail] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existingByEmail) {
    await db
      .update(users)
      .set({
        clerkId,
        name,
        username,
        passwordHash,
        isActive: true,
        orgId: null,
        role: "member",
        updatedAt: new Date(),
      })
      .where(eq(users.id, existingByEmail.id));

    console.log("user.created: reactivated existing user", clerkId, email);
    return;
  }

  await db.insert(users).values({
    clerkId,
    email,
    name,
    username,
    passwordHash,
  });

  console.log("user.created: inserted user", clerkId, email);
}

async function handleUserUpdated(db: any, data: Record<string, any>) {
  const clerkId = data.id as string;
  const email =
    data.email_addresses?.find(
      (e: any) => e.id === data.primary_email_address_id
    )?.email_address ?? data.email_addresses?.[0]?.email_address;
  const name = [data.first_name, data.last_name].filter(Boolean).join(" ") || undefined;
  const username = data.username ?? undefined;

  const updates: Record<string, any> = { updatedAt: new Date() };
  if (email) updates.email = email;
  if (name) updates.name = name;
  if (username !== undefined) updates.username = username;

  const [updated] = await db
    .update(users)
    .set(updates)
    .where(eq(users.clerkId, clerkId))
    .returning({ id: users.id });

  if (!updated) {
    console.error("user.updated: user not found for clerkId", clerkId);
    return;
  }

  console.log("user.updated: updated user", clerkId);
}

async function handleOrganizationCreated(db: any, data: Record<string, any>) {
  const clerkId = data.id as string;
  const name = data.name as string;
  const slug = data.slug as string;

  if (!name || !slug) {
    console.error("organization.created: missing name or slug", clerkId);
    return;
  }

  // Check if org already exists
  const [existing] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.clerkId, clerkId))
    .limit(1);

  if (existing) {
    console.log("organization.created: org already exists", clerkId);
    return;
  }

  await db.insert(organizations).values({
    clerkId,
    name,
    slug,
  });

  console.log("organization.created: inserted org", clerkId, slug);
}

async function handleMembershipCreated(db: any, data: Record<string, any>) {
  const clerkUserId = data.public_user_data?.user_id as string;
  const clerkOrgId = data.organization?.id as string;
  const clerkRole = data.role as string; // "org:admin" or "org:member"

  if (!clerkUserId || !clerkOrgId) {
    console.error("organizationMembership.created: missing user or org id", data);
    return;
  }

  // Find user by clerkId
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clerkId, clerkUserId))
    .limit(1);

  if (!user) {
    console.error("organizationMembership.created: user not found", clerkUserId);
    return;
  }

  // Find org by clerkId
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.clerkId, clerkOrgId))
    .limit(1);

  if (!org) {
    console.error("organizationMembership.created: org not found", clerkOrgId);
    return;
  }

  // Map Clerk role to our role
  const role = clerkRole === "org:admin" ? "org_admin" : "member";

  await db
    .update(users)
    .set({ orgId: org.id, role, updatedAt: new Date() })
    .where(eq(users.id, user.id));

  console.log("organizationMembership.created: linked user", clerkUserId, "to org", clerkOrgId);
}

async function handleUserDeleted(db: any, data: Record<string, any>) {
  const clerkId = data.id as string;

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);

  if (!user) {
    console.error("user.deleted: user not found for clerkId", clerkId);
    return;
  }

  // Deactivate user
  await db
    .update(users)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(users.id, user.id));

  // Revoke all app permissions
  await db
    .delete(appPermissions)
    .where(eq(appPermissions.userId, user.id));

  console.log("user.deleted: deactivated user and revoked permissions", clerkId);
}

async function handleOrganizationDeleted(db: any, data: Record<string, any>) {
  const clerkId = data.id as string;

  const [deleted] = await db
    .delete(organizations)
    .where(eq(organizations.clerkId, clerkId))
    .returning({ id: organizations.id });

  if (!deleted) {
    console.error("organization.deleted: org not found for clerkId", clerkId);
    return;
  }

  console.log("organization.deleted: deleted org", clerkId);
}

async function handleMembershipUpdated(db: any, data: Record<string, any>) {
  const clerkUserId = data.public_user_data?.user_id as string;
  const clerkOrgId = data.organization?.id as string;
  const clerkRole = data.role as string;

  if (!clerkUserId || !clerkOrgId) {
    console.error("organizationMembership.updated: missing user or org id", data);
    return;
  }

  const role = clerkRole === "org:admin" ? "org_admin" : "member";

  const [updated] = await db
    .update(users)
    .set({ role, updatedAt: new Date() })
    .where(eq(users.clerkId, clerkUserId))
    .returning({ id: users.id });

  if (!updated) {
    console.error("organizationMembership.updated: user not found", clerkUserId);
    return;
  }

  console.log("organizationMembership.updated: updated role to", role, "for", clerkUserId);
}

async function handleMembershipDeleted(db: any, data: Record<string, any>) {
  const clerkUserId = data.public_user_data?.user_id as string;

  if (!clerkUserId) {
    console.error("organizationMembership.deleted: missing user id", data);
    return;
  }

  const [updated] = await db
    .update(users)
    .set({ orgId: null, role: "member", updatedAt: new Date() })
    .where(eq(users.clerkId, clerkUserId))
    .returning({ id: users.id });

  if (!updated) {
    console.error("organizationMembership.deleted: user not found", clerkUserId);
    return;
  }

  console.log("organizationMembership.deleted: unlinked user from org", clerkUserId);
}

export default webhooks;
