CREATE TABLE `automation_drafts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`name` text NOT NULL,
	`instructions` text,
	`source` text NOT NULL,
	`config` text NOT NULL,
	`allowedOrigins` text NOT NULL,
	`outputCapBytes` integer NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `automations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`name` text NOT NULL,
	`instructions` text,
	`source` text NOT NULL,
	`config` text NOT NULL,
	`allowedOrigins` text NOT NULL,
	`outputCapBytes` integer DEFAULT 16384 NOT NULL,
	`state` text,
	`status` text DEFAULT 'active' NOT NULL,
	`failureCount` integer DEFAULT 0 NOT NULL,
	`lastError` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automations_scope_name_unique` ON `automations` (`scope`,`name`);--> statement-breakpoint
ALTER TABLE `cron_engine_jobs` ADD `automationIds` text;