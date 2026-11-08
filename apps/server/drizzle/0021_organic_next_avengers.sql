CREATE TABLE "librarian_attempts" (
	"org_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"request_id" text,
	"state" text NOT NULL,
	"ceiling" bigint NOT NULL,
	"charged" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "librarian_attempts_request_id_unique" UNIQUE("request_id"),
	CONSTRAINT "librarian_attempt_money" CHECK ("librarian_attempts"."ceiling" >= 0 and ("librarian_attempts"."charged" is null or "librarian_attempts"."charged" >= 0))
);
--> statement-breakpoint
CREATE TABLE "librarian_config" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"model" text DEFAULT 'claude-sonnet-5-5' NOT NULL,
	"monthly_limit" bigint DEFAULT 0 NOT NULL,
	"run_limit" bigint DEFAULT 0 NOT NULL,
	"token_id" uuid,
	"rate_card" jsonb,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "librarian_config_money" CHECK ("librarian_config"."monthly_limit" >= 0 and "librarian_config"."run_limit" >= 0 and "librarian_config"."run_limit" <= "librarian_config"."monthly_limit")
);
--> statement-breakpoint
CREATE TABLE "librarian_inbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"wiki_id" uuid NOT NULL,
	"submitted_by" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"input" jsonb,
	"quarantine_key" text,
	"note" text,
	"source_hash" text,
	"source_artifact_id" uuid,
	"extraction_version" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"run_id" uuid,
	"error_code" text,
	"untrusted" boolean DEFAULT true NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw_expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "librarian_inbox_submit_key" UNIQUE("org_id","submitted_by","idempotency_key"),
	CONSTRAINT "librarian_inbox_untrusted" CHECK ("librarian_inbox"."untrusted" = true)
);
--> statement-breakpoint
CREATE TABLE "librarian_keys" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"generation" integer NOT NULL,
	"envelope" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "librarian_months" (
	"org_id" uuid NOT NULL,
	"month" text NOT NULL,
	"settled" bigint DEFAULT 0 NOT NULL,
	"uncertain" bigint DEFAULT 0 NOT NULL,
	"reserved" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "librarian_months_org_id_month_pk" PRIMARY KEY("org_id","month"),
	CONSTRAINT "librarian_month_money" CHECK ("librarian_months"."settled" >= 0 and "librarian_months"."uncertain" >= 0 and "librarian_months"."reserved" >= 0)
);
--> statement-breakpoint
CREATE TABLE "librarian_proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"wiki_id" uuid NOT NULL,
	"proposal_key" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"markdown" text NOT NULL,
	"sources" uuid[] NOT NULL,
	"untrusted" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_artifact_id" uuid,
	CONSTRAINT "librarian_proposal_key" UNIQUE("run_id","proposal_key"),
	CONSTRAINT "librarian_proposal_bounds" CHECK ("librarian_proposals"."untrusted" = true and octet_length("librarian_proposals"."markdown") <= 1048576 and char_length("librarian_proposals"."summary") <= 2000 and char_length("librarian_proposals"."title") <= 256 and cardinality("librarian_proposals"."sources") <= 100)
);
--> statement-breakpoint
CREATE TABLE "librarian_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"tool_key" uuid NOT NULL,
	"input_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "librarian_receipt_tool" UNIQUE("run_id","tool_key"),
	CONSTRAINT "librarian_receipt_bound" CHECK (octet_length("librarian_receipts"."result"::text) <= 65536)
);
--> statement-breakpoint
CREATE TABLE "librarian_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"wiki_id" uuid NOT NULL,
	"state" text NOT NULL,
	"model" text NOT NULL,
	"config_generation" integer NOT NULL,
	"rate_card" jsonb NOT NULL,
	"owner" uuid NOT NULL,
	"fence" integer NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"month" text NOT NULL,
	"cap" bigint NOT NULL,
	"settled" bigint DEFAULT 0 NOT NULL,
	"uncertain" bigint DEFAULT 0 NOT NULL,
	"reserved" bigint NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "librarian_run_money" CHECK ("librarian_runs"."cap" >= 0 and "librarian_runs"."settled" >= 0 and "librarian_runs"."uncertain" >= 0 and "librarian_runs"."reserved" >= 0)
);
--> statement-breakpoint
CREATE TABLE "librarian_wikis" (
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"selected_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "librarian_wikis_org_id_project_id_pk" PRIMARY KEY("org_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "librarian_attempts" ADD CONSTRAINT "librarian_attempts_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "librarian_attempts" ADD CONSTRAINT "librarian_attempts_run_id_librarian_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."librarian_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "librarian_config" ADD CONSTRAINT "librarian_config_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "librarian_config" ADD CONSTRAINT "librarian_config_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "librarian_config" ADD CONSTRAINT "librarian_config_updated_by_people_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "librarian_inbox" ADD CONSTRAINT "librarian_inbox_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "librarian_inbox" ADD CONSTRAINT "librarian_inbox_wiki_id_projects_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "librarian_inbox" ADD CONSTRAINT "librarian_inbox_source_artifact_id_artifacts_id_fk" FOREIGN KEY ("source_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "librarian_inbox" ADD CONSTRAINT "librarian_inbox_run_id_librarian_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."librarian_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "librarian_keys" ADD CONSTRAINT "librarian_keys_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "librarian_keys" ADD CONSTRAINT "librarian_keys_updated_by_people_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "librarian_months" ADD CONSTRAINT "librarian_months_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "librarian_proposals" ADD CONSTRAINT "librarian_proposals_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "librarian_proposals" ADD CONSTRAINT "librarian_proposals_run_id_librarian_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."librarian_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "librarian_proposals" ADD CONSTRAINT "librarian_proposals_wiki_id_projects_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "librarian_proposals" ADD CONSTRAINT "librarian_proposals_reviewed_by_people_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "librarian_proposals" ADD CONSTRAINT "librarian_proposals_created_artifact_id_artifacts_id_fk" FOREIGN KEY ("created_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "librarian_receipts" ADD CONSTRAINT "librarian_receipts_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "librarian_receipts" ADD CONSTRAINT "librarian_receipts_run_id_librarian_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."librarian_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "librarian_runs" ADD CONSTRAINT "librarian_runs_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "librarian_runs" ADD CONSTRAINT "librarian_runs_wiki_id_projects_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "librarian_wikis" ADD CONSTRAINT "librarian_wikis_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "librarian_wikis" ADD CONSTRAINT "librarian_wikis_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "librarian_wikis" ADD CONSTRAINT "librarian_wikis_selected_by_people_id_fk" FOREIGN KEY ("selected_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "librarian_inbox_due" ON "librarian_inbox" USING btree ("org_id","status","submitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "librarian_one_active_org" ON "librarian_runs" USING btree ("org_id") WHERE "librarian_runs"."state" = 'running';