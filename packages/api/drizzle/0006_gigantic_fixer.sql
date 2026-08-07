CREATE TYPE "public"."feedback_status" AS ENUM('correct', 'incorrect', 'partial');--> statement-breakpoint
ALTER TABLE "answer_feedback" ALTER COLUMN "ui_block_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "answer_feedback" ADD COLUMN "thread_id" varchar(255);--> statement-breakpoint
ALTER TABLE "answer_feedback" ADD COLUMN "status" "feedback_status";--> statement-breakpoint
CREATE INDEX "answer_feedback_thread_id_idx" ON "answer_feedback" USING btree ("thread_id");--> statement-breakpoint
ALTER TABLE "answer_feedback" DROP COLUMN "is_correct";