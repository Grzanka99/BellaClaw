CREATE TABLE `app_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`accountId` text NOT NULL,
	`fcmToken` text NOT NULL,
	`publicKey` text NOT NULL,
	`authSecret` text NOT NULL,
	`registeredAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `app_devices_account_idx` ON `app_devices` (`accountId`);