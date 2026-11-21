ALTER TABLE `conversations` ADD `kind` text DEFAULT 'bella' NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `title` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `createdAt` integer;