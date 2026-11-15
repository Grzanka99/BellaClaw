CREATE TABLE `fact_distillation_state` (
	`chatId` text PRIMARY KEY NOT NULL,
	`lastProcessedMessageId` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `facts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chatId` text NOT NULL,
	`text` text NOT NULL,
	`embedding` F32_BLOB(768) NOT NULL,
	`createdAt` integer NOT NULL,
	`supersededBy` integer,
	`sourceMessageId` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `facts_chat_live_idx` ON `facts` (`chatId`,`supersededBy`);--> statement-breakpoint
CREATE INDEX `facts_source_message_idx` ON `facts` (`sourceMessageId`);--> statement-breakpoint
CREATE INDEX `memories_chat_id_idx` ON `memories` (`chatId`,`id`);