CREATE TYPE "public"."project_permission" AS ENUM('view', 'edit');--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "members" jsonb DEFAULT '[]'::jsonb;
