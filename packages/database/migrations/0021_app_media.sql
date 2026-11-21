CREATE TABLE `app_media` (
	`id` text PRIMARY KEY NOT NULL,
	`accountId` text NOT NULL,
	`conversationKey` text NOT NULL,
	`mimeType` text NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `app_media_conversation_idx` ON `app_media` (`conversationKey`);--> statement-breakpoint
ALTER TABLE `memories` ADD `attachments` text;--> statement-breakpoint
UPDATE `memories` SET `attachments` = (
	SELECT json_group_array(json_extract(`block`.`value`, '$.attachment'))
	FROM json_each(`memories`.`modelMessage`, '$.content') AS `block`
	WHERE json_extract(`block`.`value`, '$.attachment') IS NOT NULL
) WHERE `author` = 'user' AND json_type(`modelMessage`, '$.content') = 'array' AND `modelMessage` LIKE '%"attachment":%';
