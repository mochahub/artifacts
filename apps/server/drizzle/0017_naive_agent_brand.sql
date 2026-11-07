CREATE TYPE "public"."project_kind" AS ENUM('project', 'wiki');--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "kind" "project_kind" DEFAULT 'project' NOT NULL;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "wiki" jsonb;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "links" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX "versions_links_idx" ON "versions" USING gin ("links");