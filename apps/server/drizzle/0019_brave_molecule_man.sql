CREATE TABLE "board_assets" (
	"artifact_id" uuid NOT NULL,
	"hash" text NOT NULL,
	"org_id" uuid NOT NULL,
	"image" jsonb NOT NULL,
	"uploaded_by" uuid,
	"token_id" uuid,
	"validated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_assets_artifact_id_hash_pk" PRIMARY KEY("artifact_id","hash")
);
--> statement-breakpoint
CREATE TABLE "board_captures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"page_key" text NOT NULL,
	"version_id" uuid,
	"epoch" integer NOT NULL,
	"seq" bigint NOT NULL,
	"hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_requests" (
	"artifact_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"epoch" integer NOT NULL,
	"caller_key" text NOT NULL,
	"hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_requests_artifact_id_caller_key_request_id_pk" PRIMARY KEY("artifact_id","caller_key","request_id")
);
--> statement-breakpoint
CREATE TABLE "board_suggestions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"page_key" text NOT NULL,
	"epoch" integer NOT NULL,
	"request" jsonb NOT NULL,
	"ids" jsonb NOT NULL,
	"status" "suggestion_status" DEFAULT 'open' NOT NULL,
	"run_id" uuid,
	"author_key" text NOT NULL,
	"author_person_id" uuid,
	"agent" text,
	"token_id" uuid,
	"note" text,
	"sources" text[] DEFAULT '{}'::text[] NOT NULL,
	"fixes" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"decision_note" text,
	"version" integer
);
--> statement-breakpoint
CREATE TABLE "board_versions" (
	"version_id" uuid NOT NULL,
	"page_key" text NOT NULL,
	"org_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"hash" text NOT NULL,
	"renders" jsonb,
	"rendered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_versions_version_id_page_key_pk" PRIMARY KEY("version_id","page_key")
);
--> statement-breakpoint
ALTER TABLE "edit_docs" ADD COLUMN "kind" text DEFAULT 'article' NOT NULL;--> statement-breakpoint
ALTER TABLE "edit_presence" ADD COLUMN "objects" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "board_assets" ADD CONSTRAINT "board_assets_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_assets" ADD CONSTRAINT "board_assets_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_assets" ADD CONSTRAINT "board_assets_uploaded_by_people_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_assets" ADD CONSTRAINT "board_assets_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_captures" ADD CONSTRAINT "board_captures_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_captures" ADD CONSTRAINT "board_captures_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_captures" ADD CONSTRAINT "board_captures_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_captures" ADD CONSTRAINT "board_captures_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_requests" ADD CONSTRAINT "board_requests_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_requests" ADD CONSTRAINT "board_requests_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_suggestions" ADD CONSTRAINT "board_suggestions_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_suggestions" ADD CONSTRAINT "board_suggestions_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_suggestions" ADD CONSTRAINT "board_suggestions_run_id_edit_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."edit_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_suggestions" ADD CONSTRAINT "board_suggestions_author_person_id_people_id_fk" FOREIGN KEY ("author_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_suggestions" ADD CONSTRAINT "board_suggestions_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_suggestions" ADD CONSTRAINT "board_suggestions_decided_by_people_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_versions" ADD CONSTRAINT "board_versions_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_versions" ADD CONSTRAINT "board_versions_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_versions" ADD CONSTRAINT "board_versions_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_captures_expires_idx" ON "board_captures" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "board_suggestions_artifact_status_idx" ON "board_suggestions" USING btree ("artifact_id","status");--> statement-breakpoint
CREATE INDEX "board_suggestions_run_idx" ON "board_suggestions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "board_versions_artifact_idx" ON "board_versions" USING btree ("artifact_id");