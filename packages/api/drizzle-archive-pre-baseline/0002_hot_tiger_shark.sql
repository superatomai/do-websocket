ALTER TABLE "apps" ALTER COLUMN "icon" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "icon" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "icon" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "description" varchar;