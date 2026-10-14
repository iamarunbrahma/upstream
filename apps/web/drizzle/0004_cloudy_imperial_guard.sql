CREATE TABLE "maintainer_sessions" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"github_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"github_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "maintainers" ADD CONSTRAINT "maintainers_github_id_unique" UNIQUE("github_id");