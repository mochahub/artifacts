CREATE TABLE "artifact_usage" (
	"artifact_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"org_id" uuid NOT NULL,
	"keys" integer DEFAULT 0 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_usage_artifact_id_scope_pk" PRIMARY KEY("artifact_id","scope")
);
--> statement-breakpoint
ALTER TABLE "artifact_usage" ADD CONSTRAINT "artifact_usage_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_usage" ADD CONSTRAINT "artifact_usage_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;