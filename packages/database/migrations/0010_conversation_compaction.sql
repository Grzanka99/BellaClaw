ALTER TABLE `memories` ADD `modelMessage` text;--> statement-breakpoint
ALTER TABLE `memories` ADD `kind` text DEFAULT 'message' NOT NULL;--> statement-breakpoint
ALTER TABLE `memories` ADD `summarizedThroughId` integer;--> statement-breakpoint
ALTER TABLE `memories` ADD `platform` text;