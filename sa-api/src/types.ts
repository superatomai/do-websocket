import type { Database } from "./db";

export type Env = {
  DATABASE_URL: string;
  JWT_SECRET: string;
  CLERK_WEBHOOK_SECRET: string;
};

export type AppVariables = {
  db: Database;
  userId: string;
  orgId: string;
  userRole: "org_admin" | "member";
};
