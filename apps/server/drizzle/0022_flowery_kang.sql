ALTER TABLE "librarian_runs" ADD COLUMN "inbox_id" uuid;--> statement-breakpoint
ALTER TABLE "librarian_runs" ADD COLUMN "daily_key" text;--> statement-breakpoint
ALTER TABLE "librarian_runs" ADD CONSTRAINT "librarian_daily_wiki" UNIQUE("org_id","wiki_id","daily_key");--> statement-breakpoint
ALTER TABLE "librarian_runs" ADD CONSTRAINT "librarian_run_inbox" UNIQUE("inbox_id");