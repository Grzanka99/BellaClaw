CREATE TABLE `list_items` (
	`id` text PRIMARY KEY NOT NULL,
	`listId` text NOT NULL,
	`text` text NOT NULL,
	`done` integer DEFAULT false NOT NULL,
	`position` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `list_items_list_position_idx` ON `list_items` (`listId`,`position`);--> statement-breakpoint
CREATE TABLE `lists` (
	`id` text PRIMARY KEY NOT NULL,
	`ownerKey` text NOT NULL,
	`name` text NOT NULL,
	`expiresAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `lists_owner_idx` ON `lists` (`ownerKey`);