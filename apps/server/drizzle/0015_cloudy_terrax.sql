CREATE TYPE "public"."project_permission" AS ENUM('view', 'comment', 'publish', 'manage');--> statement-breakpoint
ALTER TYPE "public"."activity_kind" ADD VALUE 'project_access_changed';--> statement-breakpoint
ALTER TYPE "public"."invite_kind" ADD VALUE 'project';--> statement-breakpoint
CREATE TABLE "project_access" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"person_id" uuid,
	"team_id" uuid,
	"permission" "project_permission" NOT NULL,
	"granted_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_access_project_person_unique" UNIQUE("project_id","person_id"),
	CONSTRAINT "project_access_project_team_unique" UNIQUE("project_id","team_id"),
	CONSTRAINT "project_access_one_subject" CHECK (("project_access"."person_id" is null) <> ("project_access"."team_id" is null))
);
--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "project_permission" "project_permission";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "restricted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "created_by_token" uuid;--> statement-breakpoint
ALTER TABLE "project_access" ADD CONSTRAINT "project_access_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_access" ADD CONSTRAINT "project_access_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_access" ADD CONSTRAINT "project_access_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_access" ADD CONSTRAINT "project_access_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_access" ADD CONSTRAINT "project_access_granted_by_people_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_access_person_idx" ON "project_access" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "project_access_team_idx" ON "project_access" USING btree ("team_id");--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_token_tokens_id_fk" FOREIGN KEY ("created_by_token") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;