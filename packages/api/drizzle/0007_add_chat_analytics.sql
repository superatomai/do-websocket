-- Chat Analytics table for tracking user interactions, LLM usage, and costs
DO $$ BEGIN
  CREATE TYPE "public"."analytics_status" AS ENUM('success', 'error');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "chat_analytics" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "org_id" uuid,
  "project_id" uuid NOT NULL,
  "thread_id" varchar(255) NOT NULL,
  "message_index" integer NOT NULL,
  "question" text NOT NULL,
  "sources_used" jsonb,
  "sql_generated" text,
  "model" varchar(255) NOT NULL,
  "input_tokens" integer NOT NULL,
  "output_tokens" integer NOT NULL,
  "cost" numeric(12, 6) NOT NULL,
  "latency_ms" integer NOT NULL,
  "status" "analytics_status" NOT NULL,
  "error_message" text,
  "feedback" varchar(50),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Foreign keys
ALTER TABLE "chat_analytics" ADD CONSTRAINT "chat_analytics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_analytics" ADD CONSTRAINT "chat_analytics_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "chat_analytics" ADD CONSTRAINT "chat_analytics_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS "chat_analytics_user_id_idx" ON "chat_analytics" USING btree ("user_id");
CREATE INDEX IF NOT EXISTS "chat_analytics_org_id_idx" ON "chat_analytics" USING btree ("org_id");
CREATE INDEX IF NOT EXISTS "chat_analytics_project_id_idx" ON "chat_analytics" USING btree ("project_id");
CREATE INDEX IF NOT EXISTS "chat_analytics_created_at_idx" ON "chat_analytics" USING btree ("created_at");
CREATE INDEX IF NOT EXISTS "chat_analytics_model_idx" ON "chat_analytics" USING btree ("model");
CREATE INDEX IF NOT EXISTS "chat_analytics_status_idx" ON "chat_analytics" USING btree ("status");
