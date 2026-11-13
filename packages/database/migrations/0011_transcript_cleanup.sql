CREATE TABLE `conversation_summaries` (
	`chatId` text PRIMARY KEY NOT NULL,
	`summary` text NOT NULL,
	`summarizedThroughId` integer NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `conversation_summaries` (`chatId`, `summary`, `summarizedThroughId`, `createdAt`)
SELECT `chatId`, `message`, COALESCE(`summarizedThroughId`, 0), `createdAt`
FROM `memories`
WHERE `kind` = 'summary'
	AND `id` = (SELECT MAX(`latest`.`id`) FROM `memories` AS `latest` WHERE `latest`.`kind` = 'summary' AND `latest`.`chatId` = `memories`.`chatId`);--> statement-breakpoint
DELETE FROM `memories` WHERE `kind` = 'summary';--> statement-breakpoint
ALTER TABLE `memories` DROP COLUMN `importance`;--> statement-breakpoint
ALTER TABLE `memories` DROP COLUMN `summarizedThroughId`;--> statement-breakpoint
ALTER TABLE `memories` DROP COLUMN `platform`;--> statement-breakpoint
ALTER TABLE `memories` DROP COLUMN `lastReadAt`;
