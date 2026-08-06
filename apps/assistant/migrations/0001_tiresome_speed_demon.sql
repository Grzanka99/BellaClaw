ALTER TABLE cron_engine_jobs ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
--> statement-breakpoint
ALTER TABLE cron_engine_jobs ADD COLUMN finishedAt INTEGER;
--> statement-breakpoint
ALTER TABLE cron_engine_jobs ADD COLUMN finishedReason TEXT;
--> statement-breakpoint
DROP INDEX `cron_engine_jobs_name_scope_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `cron_engine_jobs_name_scope_unique` ON `cron_engine_jobs` (`name`,`scope`) WHERE "cron_engine_jobs"."status" = 'active';
