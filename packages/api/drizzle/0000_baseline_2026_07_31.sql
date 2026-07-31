CREATE TYPE "public"."analytics_status" AS ENUM('success', 'error', 'aborted');--> statement-breakpoint
CREATE TYPE "public"."analytics_type" AS ENUM('chat_agent', 'dashboard', 'report');--> statement-breakpoint
CREATE TYPE "public"."app_type" AS ENUM('dashboard', 'app', 'report', 'chat_agent');--> statement-breakpoint
CREATE TYPE "public"."permission_level" AS ENUM('view', 'edit', 'admin');--> statement-breakpoint
CREATE TYPE "public"."sso_provider" AS ENUM('microsoft_entra', 'okta', 'generic_oidc', 'saml');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('super_admin', 'org_admin', 'member');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" varchar(255) NOT NULL,
	"org_id" uuid,
	"key_hash" varchar(255) NOT NULL,
	"key_prefix" varchar(20) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" varchar(255),
	"description" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"permission" "permission_level" NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"type" "app_type" NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" varchar,
	"icon" text,
	"config" jsonb,
	"created_by" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_analytics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "analytics_type" DEFAULT 'chat_agent' NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid,
	"project_id" uuid NOT NULL,
	"thread_id" varchar(255),
	"message_index" integer,
	"question" text,
	"sources_used" jsonb,
	"sql_generated" text,
	"app_id" varchar(255),
	"conversation_id" integer,
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
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"icon" text,
	"default_app_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"description" text,
	"icon" text,
	"design_system" jsonb,
	"config" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" "sso_provider" NOT NULL,
	"protocol" varchar(10) DEFAULT 'oidc' NOT NULL,
	"client_id" varchar(500),
	"client_secret" text,
	"issuer_url" varchar(1000),
	"scopes" varchar(500) DEFAULT 'openid email profile',
	"saml_idp_entity_id" varchar(1000),
	"saml_idp_sso_url" varchar(1000),
	"saml_idp_certificates" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_configs_org_id_unique" UNIQUE("org_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"email" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"password_hash" varchar(255),
	"sso_subject" varchar(500),
	"role" "user_role" DEFAULT 'member' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_permissions" ADD CONSTRAINT "app_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_permissions" ADD CONSTRAINT "app_permissions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_permissions" ADD CONSTRAINT "app_permissions_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_analytics" ADD CONSTRAINT "chat_analytics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_analytics" ADD CONSTRAINT "chat_analytics_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_analytics" ADD CONSTRAINT "chat_analytics_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_configs" ADD CONSTRAINT "sso_configs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_api_keys_active" ON "api_keys" USING btree ("project_id") WHERE "api_keys"."is_active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "app_permissions_user_app_idx" ON "app_permissions" USING btree ("user_id","app_id");--> statement-breakpoint
CREATE INDEX "chat_analytics_type_idx" ON "chat_analytics" USING btree ("type");--> statement-breakpoint
CREATE INDEX "chat_analytics_app_id_idx" ON "chat_analytics" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "chat_analytics_conversation_id_idx" ON "chat_analytics" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "chat_analytics_user_id_idx" ON "chat_analytics" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chat_analytics_org_id_idx" ON "chat_analytics" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "chat_analytics_project_id_idx" ON "chat_analytics" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "chat_analytics_created_at_idx" ON "chat_analytics" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "chat_analytics_model_idx" ON "chat_analytics" USING btree ("model");--> statement-breakpoint
CREATE INDEX "chat_analytics_status_idx" ON "chat_analytics" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_org_slug_idx" ON "projects" USING btree ("org_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "users_org_email_idx" ON "users" USING btree ("org_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_org_sso_subject_idx" ON "users" USING btree ("org_id","sso_subject");