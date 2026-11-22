-- paperclip:migration-compat requires_staging: pause table writers while PostgreSQL validates foreign keys on existing rows
ALTER TABLE "projects" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;