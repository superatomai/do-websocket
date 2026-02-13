/**
 * Seed script — creates the first organization and admin user.
 * Run once: npx tsx seed.ts
 */
import { neon } from "@neondatabase/serverless";

const DATABASE_URL =
  "postgresql://neondb_owner:***REMOVED***@ep-nameless-truth-ahrn3rao-pooler.c-3.us-east-1.aws.neon.tech/neondb?sslmode=require";

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function seed() {
  const sql = neon(DATABASE_URL);

  // 1. Create organization
  const [org] = await sql`
    INSERT INTO organizations (name, slug)
    VALUES ('Superatom', 'superatom')
    RETURNING id, name, slug
  `;
  console.log("✓ Organization created:", org);

  // 2. Create admin user (password: admin123)
  const passwordHash = await hashPassword("gopi");
  const [admin] = await sql`
    INSERT INTO users (org_id, email, username, name, password_hash, role)
    VALUES (${org.id}, 'gopinadh@superatom.ai', 'gopi', 'Gopinadh', ${passwordHash}, 'org_admin')
    RETURNING id, email, username, name, role
  `;
  console.log("✓ Admin user created:", admin);

  console.log("\n--- You can now login ---");
  console.log(`POST https://sa-api.ashish-91e.workers.dev/auth/login`);
  console.log(`Body: { "username": "admin", "password": "admin123" }`);
}

seed().catch(console.error);
