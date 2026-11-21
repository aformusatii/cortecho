CREATE TABLE `app_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `discovery_ignored` (
	`mac` text PRIMARY KEY NOT NULL,
	`ignored_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `devices` ADD `mac` text;--> statement-breakpoint
CREATE UNIQUE INDEX `devices_mac_idx` ON `devices` (`mac`);