ALTER TYPE "public"."delivery_status" ADD VALUE 'draft' BEFORE 'queued';--> statement-breakpoint
ALTER TYPE "public"."delivery_status" ADD VALUE 'discarded' BEFORE 'queued';