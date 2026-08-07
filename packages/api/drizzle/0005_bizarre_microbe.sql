CREATE TABLE "answer_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar(255),
	"project_id" varchar(255),
	"user_id" varchar(255),
	"ui_block_id" varchar(255),
	"user_prompt" text NOT NULL,
	"is_correct" boolean NOT NULL,
	"feedback_text" text,
	"answer_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar(255),
	"user_id" varchar(255),
	"category" varchar(50),
	"message" text NOT NULL,
	"page_context" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "answer_feedback_org_id_idx" ON "answer_feedback" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "answer_feedback_ui_block_id_idx" ON "answer_feedback" USING btree ("ui_block_id");--> statement-breakpoint
CREATE INDEX "answer_feedback_created_at_idx" ON "answer_feedback" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "product_feedback_org_id_idx" ON "product_feedback" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "product_feedback_category_idx" ON "product_feedback" USING btree ("category");--> statement-breakpoint
CREATE INDEX "product_feedback_created_at_idx" ON "product_feedback" USING btree ("created_at");