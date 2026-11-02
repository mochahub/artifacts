ALTER TYPE "public"."activity_kind" ADD VALUE 'identity_linked';--> statement-breakpoint
CREATE TABLE "google_states" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"state_hash" text NOT NULL,
	"browser_hash" text NOT NULL,
	"nonce" text NOT NULL,
	"code_verifier" text NOT NULL,
	"intent" text NOT NULL,
	"session_id" uuid,
	"person_id" uuid,
	"invite_id" uuid,
	"next" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "google_states_state_hash_unique" UNIQUE("state_hash")
);
--> statement-breakpoint
CREATE TABLE "identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"email" text NOT NULL,
	"hosted_domain" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "identities_org_provider_subject_unique" UNIQUE("org_id","provider","subject"),
	CONSTRAINT "identities_person_provider_unique" UNIQUE("person_id","provider")
);
--> statement-breakpoint
CREATE TABLE "removed_identities" (
	"org_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"subject_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "removed_identities_org_id_provider_subject_hash_pk" PRIMARY KEY("org_id","provider","subject_hash")
);
--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "google_client_id" text;--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "google_client_secret" text;--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "google_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "google_tested_by" uuid;--> statement-breakpoint
ALTER TABLE "google_states" ADD CONSTRAINT "google_states_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_states" ADD CONSTRAINT "google_states_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_states" ADD CONSTRAINT "google_states_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_states" ADD CONSTRAINT "google_states_invite_id_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."invites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "removed_identities" ADD CONSTRAINT "removed_identities_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org" ADD CONSTRAINT "org_google_tested_by_people_id_fk" FOREIGN KEY ("google_tested_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;