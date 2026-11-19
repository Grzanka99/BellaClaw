CREATE TABLE `conversations` (
	`conversationKey` text PRIMARY KEY NOT NULL,
	`ownerKey` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `identity_links` ADD `movedOwners` text DEFAULT '[]' NOT NULL;