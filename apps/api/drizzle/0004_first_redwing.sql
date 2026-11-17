CREATE TABLE `mcp_credentials` (
	`server_id` integer PRIMARY KEY NOT NULL,
	`issuer` text DEFAULT '' NOT NULL,
	`client_info_enc` text,
	`tokens_enc` text,
	`discovery_enc` text,
	`granted_scope` text DEFAULT '' NOT NULL,
	`account_label` text,
	`expires_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `mcp_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`catalog_id` text,
	`transport` text DEFAULT 'streamable-http' NOT NULL,
	`url` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`auth_type` text DEFAULT 'none' NOT NULL,
	`headers_enc` text,
	`oauth_config` text DEFAULT '{}' NOT NULL,
	`oauth_client_secret_enc` text,
	`timeout_ms` integer DEFAULT 10000 NOT NULL,
	`max_result_chars` integer DEFAULT 4000 NOT NULL,
	`use_server_instructions` integer DEFAULT false NOT NULL,
	`status_detail` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_slug_idx` ON `mcp_servers` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_name_idx` ON `mcp_servers` (`name`);--> statement-breakpoint
CREATE TABLE `mcp_tools` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` integer NOT NULL,
	`name` text NOT NULL,
	`exposed_name` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`input_schema` text DEFAULT '{}' NOT NULL,
	`annotations` text DEFAULT '{}' NOT NULL,
	`definition_hash` text NOT NULL,
	`approved_hash` text,
	`policy` text DEFAULT 'off' NOT NULL,
	`present` integer DEFAULT true NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `mcp_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_tools_server_name_idx` ON `mcp_tools` (`server_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_tools_exposed_name_idx` ON `mcp_tools` (`exposed_name`);