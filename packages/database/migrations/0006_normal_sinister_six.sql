CREATE TABLE `message_authorizations` (
	`chatId` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`failedAttempts` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "message_authorizations_status_check" CHECK("message_authorizations"."status" in ('pending', 'authorized', 'locked')),
	CONSTRAINT "message_authorizations_failed_attempts_check" CHECK("message_authorizations"."failedAttempts" between 0 and 3)
);
