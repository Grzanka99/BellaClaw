CREATE TABLE `cron_engine_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`scope` text NOT NULL,
	`group` text,
	`type` text NOT NULL,
	`pattern` text,
	`reminderText` text,
	`reminderPromptData` text,
	`reminderFallbackText` text,
	`nextRunAt` integer NOT NULL,
	`lastRunAt` integer,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cron_engine_jobs_name_scope_unique` ON `cron_engine_jobs` (`name`,`scope`);--> statement-breakpoint
CREATE TABLE `memories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chatId` text NOT NULL,
	`author` text NOT NULL,
	`importance` text NOT NULL,
	`message` text NOT NULL,
	`createdAt` integer NOT NULL,
	`lastReadAt` integer NOT NULL
);
