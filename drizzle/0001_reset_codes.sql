ALTER TABLE "password_resets" DROP CONSTRAINT "password_resets_token_hash_unique";--> statement-breakpoint
ALTER TABLE "password_resets" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;