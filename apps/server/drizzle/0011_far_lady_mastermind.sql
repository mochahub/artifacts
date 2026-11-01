ALTER TABLE "versions" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "tags" text[];--> statement-breakpoint
CREATE INDEX "blocks_search_idx" ON "blocks" USING gin (to_tsvector('english', "text"));--> statement-breakpoint
CREATE INDEX "comments_search_idx" ON "comments" USING gin (to_tsvector('english', "body"));--> statement-breakpoint
CREATE INDEX "projects_org_repo_idx" ON "projects" USING btree ("org_id",lower("repo"));