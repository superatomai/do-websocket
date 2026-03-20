import type { Database } from "./db";

export type Env = {
  DATABASE_URL: string;
  JWT_SECRET: string;
  PLATFORM_UI_URL: string;
  R2_BUCKET: R2Bucket;
  R2_PUBLIC_URL: string; // e.g. "https://sa-assets.superatom.ai" or "https://pub-xxx.r2.dev"
};

export type AppVariables = {
  db: Database;
  userId: string;
  orgId: string | null;
  userRole: "super_admin" | "org_admin" | "member";
};
