CREATE TABLE `calendars` (
	`calendarId` text PRIMARY KEY NOT NULL,
	`access` text NOT NULL,
	`addedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendars_single_write_unique` ON `calendars` (`access`) WHERE "calendars"."access" = 'write';