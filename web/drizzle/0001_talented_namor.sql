ALTER TABLE "payments" ADD COLUMN "pay_address" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "payin_extra_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "network" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "payment_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "last_polled_at" timestamp with time zone;