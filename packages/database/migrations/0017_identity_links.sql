CREATE TABLE `identity_links` (
	`channel` text NOT NULL,
	`address` text NOT NULL,
	`accountId` text NOT NULL,
	`state` text NOT NULL,
	`linkedAt` integer NOT NULL,
	PRIMARY KEY(`channel`, `address`),
	CONSTRAINT "identity_links_state_check" CHECK("identity_links"."state" in ('migrating', 'active'))
);
