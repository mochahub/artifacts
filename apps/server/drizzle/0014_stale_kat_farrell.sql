CREATE TYPE "public"."team_role" AS ENUM('lead', 'member');--> statement-breakpoint
ALTER TYPE "public"."activity_kind" ADD VALUE 'team_created';--> statement-breakpoint
ALTER TYPE "public"."activity_kind" ADD VALUE 'team_deleted';--> statement-breakpoint
ALTER TYPE "public"."activity_kind" ADD VALUE 'team_member_added';--> statement-breakpoint
ALTER TYPE "public"."activity_kind" ADD VALUE 'team_member_removed';--> statement-breakpoint
CREATE TABLE "artifact_team_access" (
	"artifact_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"permission" "permission" NOT NULL,
	"granted_by" uuid NOT NULL,
	"via_token" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_team_access_artifact_id_team_id_pk" PRIMARY KEY("artifact_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"team_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"role" "team_role" DEFAULT 'member' NOT NULL,
	"added_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_members_team_id_person_id_pk" PRIMARY KEY("team_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_org_slug_unique" UNIQUE("org_id","slug")
);
--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "team_ids" uuid[];--> statement-breakpoint
ALTER TABLE "artifact_team_access" ADD CONSTRAINT "artifact_team_access_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_team_access" ADD CONSTRAINT "artifact_team_access_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_team_access" ADD CONSTRAINT "artifact_team_access_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_team_access" ADD CONSTRAINT "artifact_team_access_granted_by_people_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_added_by_people_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_team_access_team_idx" ON "artifact_team_access" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "team_members_person_idx" ON "team_members" USING btree ("person_id");