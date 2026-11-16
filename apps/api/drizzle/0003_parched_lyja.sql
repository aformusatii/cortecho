CREATE TABLE `devices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'echo' NOT NULL,
	`host` text NOT NULL,
	`port` integer DEFAULT 26053 NOT NULL,
	`api_key` text,
	`enabled` integer DEFAULT true NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`overrides` text DEFAULT '{}' NOT NULL,
	`node_name` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_name_idx` ON `devices` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `devices_host_port_idx` ON `devices` (`host`,`port`);--> statement-breakpoint
ALTER TABLE `turns` ADD `device_id` integer REFERENCES devices(id);--> statement-breakpoint
ALTER TABLE `turns` ADD `settings_version` integer;--> statement-breakpoint
CREATE INDEX `turns_device_id_idx` ON `turns` (`device_id`);