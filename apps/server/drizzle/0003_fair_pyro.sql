CREATE TABLE "blobs" (
	"org_id" uuid NOT NULL,
	"hash" text NOT NULL,
	"size" bigint NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blobs_org_id_hash_pk" PRIMARY KEY("org_id","hash")
);
--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;