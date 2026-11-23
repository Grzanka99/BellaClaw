CREATE TABLE `connectors` (
	`ownerKey` text NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`description` text NOT NULL,
	`plainChats` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`ownerKey`, `id`)
);
