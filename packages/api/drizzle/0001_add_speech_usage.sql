CREATE TABLE "speech_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar(255),
	"user_id" varchar(255),
	"project_id" varchar(255),
	"model" varchar(128) NOT NULL,
	"audio_bytes" integer NOT NULL,
	"audio_seconds" numeric,
	"cost" numeric,
	"latency_ms" integer,
	"ok" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "speech_usage_org_id_idx" ON "speech_usage" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "speech_usage_user_id_idx" ON "speech_usage" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "speech_usage_created_at_idx" ON "speech_usage" USING btree ("created_at");