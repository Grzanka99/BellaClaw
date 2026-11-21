CREATE TABLE `__new_memories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chatId` text NOT NULL,
	`channel` text NOT NULL,
	`author` text NOT NULL,
	`message` text NOT NULL,
	`modelMessage` text,
	`kind` text DEFAULT 'message' NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
-- the key prefix is the channel
INSERT INTO `__new_memories` (`id`, `chatId`, `channel`, `author`, `message`, `modelMessage`, `kind`, `createdAt`)
SELECT `id`, `chatId`,
	CASE
		WHEN `chatId` LIKE 'signal:_%' THEN 'signal'
		WHEN `chatId` LIKE 'discord:_%' THEN 'discord'
	END,
	`author`, `message`, `modelMessage`, `kind`, `createdAt`
FROM `memories`;
--> statement-breakpoint
-- a stored attachment reference names its channel and the address it came from
UPDATE `__new_memories` SET `modelMessage` = json_set(`modelMessage`, '$.content', (
	SELECT json_group_array(
		CASE
			WHEN json_type(`block`.`value`, '$.attachment') = 'object' THEN json_set(
				`block`.`value`,
				'$.attachment.channel', `__new_memories`.`channel`,
				'$.attachment.sourceAddress', substr(`__new_memories`.`chatId`, length(`__new_memories`.`channel`) + 2)
			)
			ELSE json(`block`.`value`)
		END
	)
	FROM (
		SELECT `value` FROM json_each(`__new_memories`.`modelMessage`, '$.content') ORDER BY `key`
	) AS `block`
))
WHERE `author` = 'user'
	AND json_type(`modelMessage`, '$.content') = 'array'
	AND `modelMessage` LIKE '%"attachment":%';
--> statement-breakpoint
-- ids stay unused after a delete, as before
DELETE FROM `sqlite_sequence` WHERE `name` = '__new_memories';
--> statement-breakpoint
INSERT INTO `sqlite_sequence` (`name`, `seq`)
SELECT '__new_memories', `seq` FROM `sqlite_sequence` WHERE `name` = 'memories';
--> statement-breakpoint
DROP TABLE `memories`;
--> statement-breakpoint
ALTER TABLE `__new_memories` RENAME TO `memories`;
--> statement-breakpoint
CREATE INDEX `memories_chat_id_idx` ON `memories` (`chatId`,`id`);
