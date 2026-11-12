CREATE TABLE `event_deliveries` (
	`eventSeq` integer NOT NULL,
	`consumer` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lastError` text,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`eventSeq`, `consumer`)
);
--> statement-breakpoint
CREATE INDEX `event_deliveries_pending_idx` ON `event_deliveries` (`status`,`eventSeq`);--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`type` text NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`key` text NOT NULL,
	`turnId` text NOT NULL,
	`chatId` text,
	`platform` text,
	`causationId` text,
	`dedupeKey` text,
	`payload` text,
	`occurredAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_id_unique` ON `events` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `events_dedupe_key_unique` ON `events` (`dedupeKey`);--> statement-breakpoint
CREATE INDEX `events_causation_idx` ON `events` (`causationId`);--> statement-breakpoint
CREATE INDEX `events_turn_idx` ON `events` (`turnId`,`seq`);