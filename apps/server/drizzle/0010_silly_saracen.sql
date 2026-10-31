ALTER TABLE "artifact_access" ADD COLUMN "via_token" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "via_token" boolean DEFAULT false NOT NULL;