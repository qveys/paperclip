-- paperclip:migration-compat requires_staging: pause the previous release while this migration changes defaults used by old inserts
ALTER TABLE "user_workspace_preferences" ALTER COLUMN "coordinator_workspace_enabled" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "user_workspace_preferences" ADD COLUMN IF NOT EXISTS "classic_workspace_enabled" boolean DEFAULT false NOT NULL;