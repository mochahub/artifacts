CREATE TYPE "public"."atom_kind" AS ENUM('image', 'chart', 'mermaid', 'frame', 'html', 'markdown');--> statement-breakpoint
CREATE TYPE "public"."checkpoint_kind" AS ENUM('saved', 'quiet', 'delegate', 'agent', 'handoff');--> statement-breakpoint
CREATE TYPE "public"."edit_mode" AS ENUM('write', 'pair', 'delegate');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('active', 'finished', 'accepted', 'rejected', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."suggestion_op" AS ENUM('replace', 'insert', 'delete', 'meta');--> statement-breakpoint
CREATE TYPE "public"."suggestion_status" AS ENUM('open', 'accepted', 'rejected', 'stale', 'expired', 'withdrawn');--> statement-breakpoint
ALTER TYPE "public"."activity_kind" ADD VALUE 'checkpointed';--> statement-breakpoint
ALTER TYPE "public"."activity_kind" ADD VALUE 'edited';--> statement-breakpoint
ALTER TYPE "public"."activity_kind" ADD VALUE 'suggested';--> statement-breakpoint
ALTER TYPE "public"."activity_kind" ADD VALUE 'suggestion_accepted';--> statement-breakpoint
ALTER TYPE "public"."activity_kind" ADD VALUE 'suggestion_rejected';--> statement-breakpoint
ALTER TYPE "public"."activity_kind" ADD VALUE 'run_started';--> statement-breakpoint
ALTER TYPE "public"."activity_kind" ADD VALUE 'run_finished';--> statement-breakpoint
ALTER TYPE "public"."activity_kind" ADD VALUE 'maintained_changed';--> statement-breakpoint
ALTER TYPE "public"."permission" ADD VALUE 'edit' BEFORE 'publish';--> statement-breakpoint
ALTER TYPE "public"."project_permission" ADD VALUE 'edit' BEFORE 'publish';--> statement-breakpoint
CREATE TABLE "block_aliases" (
	"artifact_id" uuid NOT NULL,
	"legacy_key" text NOT NULL,
	"org_id" uuid NOT NULL,
	"block_id" text NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "block_aliases_artifact_id_legacy_key_pk" PRIMARY KEY("artifact_id","legacy_key")
);
--> statement-breakpoint
CREATE TABLE "edit_atoms" (
	"artifact_id" uuid NOT NULL,
	"hash" text NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "atom_kind" NOT NULL,
	"source" text NOT NULL,
	"svg" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edit_atoms_artifact_id_hash_pk" PRIMARY KEY("artifact_id","hash")
);
--> statement-breakpoint
CREATE TABLE "edit_authors" (
	"artifact_id" uuid NOT NULL,
	"key" text NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"person_id" uuid,
	"agent" text,
	"token_id" uuid,
	"sources" text[] DEFAULT '{}'::text[] NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edit_authors_artifact_id_key_pk" PRIMARY KEY("artifact_id","key"),
	CONSTRAINT "edit_authors_artifact_fingerprint_unique" UNIQUE("artifact_id","fingerprint")
);
--> statement-breakpoint
CREATE TABLE "edit_docs" (
	"artifact_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"page_key" text NOT NULL,
	"epoch" integer DEFAULT 1 NOT NULL,
	"base_version" integer NOT NULL,
	"version" integer NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL,
	"checkpoint_seq" bigint DEFAULT 0 NOT NULL,
	"snapshot_seq" bigint DEFAULT 0 NOT NULL,
	"snapshot" "bytea" NOT NULL,
	"meta" jsonb,
	"author_counter" integer DEFAULT 0 NOT NULL,
	"last_actor_person_id" uuid,
	"last_agent" text,
	"dirty_since" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edit_presence" (
	"artifact_id" uuid NOT NULL,
	"connection_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"mode" "edit_mode" NOT NULL,
	"blocks" text[] DEFAULT '{}'::text[] NOT NULL,
	"replica" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "edit_presence_artifact_id_connection_id_pk" PRIMARY KEY("artifact_id","connection_id")
);
--> statement-breakpoint
CREATE TABLE "edit_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"status" "run_status" DEFAULT 'active' NOT NULL,
	"edits" text NOT NULL,
	"goal" text NOT NULL,
	"agent" text,
	"started_by" uuid NOT NULL,
	"token_id" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"decided_by" uuid,
	"version" integer
);
--> statement-breakpoint
CREATE TABLE "edit_updates" (
	"artifact_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"org_id" uuid NOT NULL,
	"epoch" integer NOT NULL,
	"update" "bytea" NOT NULL,
	"actor_person_id" uuid,
	"agent" text,
	"token_id" uuid,
	"origin" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edit_updates_artifact_id_seq_pk" PRIMARY KEY("artifact_id","seq")
);
--> statement-breakpoint
CREATE TABLE "suggestions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"page_key" text NOT NULL,
	"op" "suggestion_op" NOT NULL,
	"block_id" text,
	"new_block_id" text,
	"base" text,
	"markdown" text,
	"meta" jsonb,
	"note" text,
	"sources" text[] DEFAULT '{}'::text[] NOT NULL,
	"fixes" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"status" "suggestion_status" DEFAULT 'open' NOT NULL,
	"run_id" uuid,
	"author_key" text NOT NULL,
	"author_person_id" uuid,
	"agent" text,
	"token_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"decision_note" text,
	"version" integer
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "agent_maintained" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "agent_maintained_by" uuid;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "agent_maintained_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "blocks" ADD COLUMN "authors" jsonb;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "checkpoint" "checkpoint_kind";--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "doc_seq" bigint;--> statement-breakpoint
ALTER TABLE "block_aliases" ADD CONSTRAINT "block_aliases_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "block_aliases" ADD CONSTRAINT "block_aliases_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_atoms" ADD CONSTRAINT "edit_atoms_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_atoms" ADD CONSTRAINT "edit_atoms_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_authors" ADD CONSTRAINT "edit_authors_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_authors" ADD CONSTRAINT "edit_authors_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_authors" ADD CONSTRAINT "edit_authors_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_authors" ADD CONSTRAINT "edit_authors_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_docs" ADD CONSTRAINT "edit_docs_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_docs" ADD CONSTRAINT "edit_docs_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_docs" ADD CONSTRAINT "edit_docs_last_actor_person_id_people_id_fk" FOREIGN KEY ("last_actor_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_presence" ADD CONSTRAINT "edit_presence_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_presence" ADD CONSTRAINT "edit_presence_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_presence" ADD CONSTRAINT "edit_presence_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_runs" ADD CONSTRAINT "edit_runs_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_runs" ADD CONSTRAINT "edit_runs_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_runs" ADD CONSTRAINT "edit_runs_started_by_people_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_runs" ADD CONSTRAINT "edit_runs_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_runs" ADD CONSTRAINT "edit_runs_decided_by_people_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_updates" ADD CONSTRAINT "edit_updates_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_updates" ADD CONSTRAINT "edit_updates_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_updates" ADD CONSTRAINT "edit_updates_actor_person_id_people_id_fk" FOREIGN KEY ("actor_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_updates" ADD CONSTRAINT "edit_updates_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_run_id_edit_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."edit_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_author_person_id_people_id_fk" FOREIGN KEY ("author_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_decided_by_people_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edit_presence_seen_idx" ON "edit_presence" USING btree ("seen_at");--> statement-breakpoint
CREATE INDEX "edit_runs_artifact_status_idx" ON "edit_runs" USING btree ("artifact_id","status");--> statement-breakpoint
CREATE INDEX "suggestions_artifact_status_idx" ON "suggestions" USING btree ("artifact_id","status");--> statement-breakpoint
CREATE INDEX "suggestions_run_idx" ON "suggestions" USING btree ("run_id");--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_agent_maintained_by_people_id_fk" FOREIGN KEY ("agent_maintained_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;