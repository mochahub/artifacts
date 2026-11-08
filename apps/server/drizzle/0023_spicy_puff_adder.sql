CREATE TABLE "librarian_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "librarian_events" ADD CONSTRAINT "librarian_events_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "librarian_events" ADD CONSTRAINT "librarian_events_run_id_librarian_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."librarian_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "librarian_events_run" ON "librarian_events" USING btree ("run_id","created_at","id");