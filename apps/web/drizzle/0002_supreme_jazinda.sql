CREATE TABLE "accruals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"settlement_id" uuid NOT NULL,
	"funder_id" uuid NOT NULL,
	"login" text NOT NULL,
	"ecosystem" text NOT NULL,
	"name" text NOT NULL,
	"cents" integer NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"return_reason" text,
	"payout_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintainers" (
	"login" text PRIMARY KEY NOT NULL,
	"github_id" integer,
	"paypal_payer_id" text,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintainers_paypal_payer_id_unique" UNIQUE("paypal_payer_id")
);
--> statement-breakpoint
CREATE TABLE "payout_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"settlement_id" uuid NOT NULL,
	"login" text NOT NULL,
	"payer_id" text NOT NULL,
	"cents" integer NOT NULL,
	"paypal_item_id" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"fee_cents" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipient_cache" (
	"repo" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payout_batch_id" text,
	"batch_status" text
);
--> statement-breakpoint
ALTER TABLE "funding_events" ADD COLUMN "refund_of" text;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "settlement_id" uuid;--> statement-breakpoint
ALTER TABLE "accruals" ADD CONSTRAINT "accruals_settlement_id_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accruals" ADD CONSTRAINT "accruals_funder_id_accounts_id_fk" FOREIGN KEY ("funder_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accruals" ADD CONSTRAINT "accruals_payout_item_id_payout_items_id_fk" FOREIGN KEY ("payout_item_id") REFERENCES "public"."payout_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_settlement_id_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accruals_funder" ON "accruals" USING btree ("funder_id");--> statement-breakpoint
CREATE INDEX "accruals_login_status" ON "accruals" USING btree ("login","status");--> statement-breakpoint
CREATE INDEX "payout_items_settlement" ON "payout_items" USING btree ("settlement_id");--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_settlement_id_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE no action ON UPDATE no action;