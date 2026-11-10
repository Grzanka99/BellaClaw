CREATE TABLE `__new_cron_engine_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`scope` text NOT NULL,
	`type` text NOT NULL,
	`pattern` text,
	`contentKind` text NOT NULL,
	`contentBody` text NOT NULL,
	`contentFallback` text,
	`nextRunAt` integer NOT NULL,
	`lastRunAt` integer,
	`createdAt` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`finishedAt` integer,
	`finishedReason` text,
	`timezone` text
);
--> statement-breakpoint
INSERT INTO `__new_cron_engine_jobs` (`id`, `name`, `scope`, `type`, `pattern`, `contentKind`, `contentBody`, `contentFallback`, `nextRunAt`, `lastRunAt`, `createdAt`, `status`, `finishedAt`, `finishedReason`, `timezone`)
SELECT `id`, `name`, `scope`, `type`, `pattern`,
	CASE
		WHEN `taskPrompt` IS NOT NULL THEN 'task'
		WHEN `reminderPromptData` IS NOT NULL THEN 'generated'
		ELSE 'text'
	END,
	CASE
		WHEN `taskPrompt` IS NOT NULL THEN `taskPrompt`
		WHEN `reminderPromptData` IS NOT NULL THEN `reminderPromptData`
		ELSE COALESCE(`reminderText`, `reminderFallbackText`, '')
	END,
	CASE
		WHEN `taskPrompt` IS NOT NULL THEN `taskFallbackText`
		WHEN `reminderPromptData` IS NOT NULL THEN `reminderFallbackText`
		ELSE NULL
	END,
	`nextRunAt`, `lastRunAt`, `createdAt`, `status`, `finishedAt`, `finishedReason`, `timezone`
FROM `cron_engine_jobs`;--> statement-breakpoint
UPDATE `sqlite_sequence` SET `seq` = (SELECT `seq` FROM `sqlite_sequence` WHERE `name` = 'cron_engine_jobs') WHERE `name` = '__new_cron_engine_jobs' AND EXISTS (SELECT 1 FROM `sqlite_sequence` WHERE `name` = 'cron_engine_jobs');--> statement-breakpoint
DROP TABLE `cron_engine_jobs`;--> statement-breakpoint
ALTER TABLE `__new_cron_engine_jobs` RENAME TO `cron_engine_jobs`;--> statement-breakpoint
CREATE UNIQUE INDEX `cron_engine_jobs_name_scope_unique` ON `cron_engine_jobs` (`name`,`scope`) WHERE "cron_engine_jobs"."status" = 'active';
