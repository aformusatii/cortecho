CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`old_value` text,
	`new_value` text,
	`version` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `settings_changes_scope_idx` ON `settings_changes` (`scope`,`id`);--> statement-breakpoint
CREATE TABLE `settings_meta` (
	`id` integer PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 0 NOT NULL
);
