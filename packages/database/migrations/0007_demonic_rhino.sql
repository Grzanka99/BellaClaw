PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_calendars` (
	`userId` text DEFAULT '' NOT NULL,
	`calendarId` text NOT NULL,
	`access` text NOT NULL,
	`addedAt` integer NOT NULL,
	PRIMARY KEY(`userId`, `calendarId`),
	CONSTRAINT "calendars_access_check" CHECK("__new_calendars"."access" in ('read', 'write'))
);
--> statement-breakpoint
INSERT INTO `__new_calendars`("userId", "calendarId", "access", "addedAt") SELECT '', "calendarId", "access", "addedAt" FROM `calendars`;--> statement-breakpoint
DROP TABLE `calendars`;--> statement-breakpoint
ALTER TABLE `__new_calendars` RENAME TO `calendars`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `calendars_single_write_unique` ON `calendars` (`userId`) WHERE "calendars"."access" = 'write';