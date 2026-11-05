CREATE TABLE "brand_proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"brand" jsonb NOT NULL,
	"artifact_id" uuid,
	"proposed_by" uuid NOT NULL,
	"agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"applied_by" uuid
);
--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "brand" jsonb;--> statement-breakpoint
ALTER TABLE "brand_proposals" ADD CONSTRAINT "brand_proposals_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_proposals" ADD CONSTRAINT "brand_proposals_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_proposals" ADD CONSTRAINT "brand_proposals_proposed_by_people_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_proposals" ADD CONSTRAINT "brand_proposals_applied_by_people_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;