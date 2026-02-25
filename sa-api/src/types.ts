import type { Database } from "./db";

export type Env = {
  DATABASE_URL: string;
  JWT_SECRET: string;
  PLATFORM_UI_URL: string;
};

export type AppVariables = {
  db: Database;
  userId: string;
  orgId: string | null;
  userRole: "super_admin" | "org_admin" | "member";
};
