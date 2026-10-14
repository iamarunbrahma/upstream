CREATE TABLE "agent_payments" (
	"order_id" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"cents" integer NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"captured_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_payments" ADD CONSTRAINT "agent_payments_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_payments_account" ON "agent_payments" USING btree ("account_id");