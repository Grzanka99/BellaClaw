CREATE TABLE `user_configs` (
	`ownerKey` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`ownerKey`, `key`)
);
