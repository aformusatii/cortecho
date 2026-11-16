CREATE TABLE `turns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`outcome` text NOT NULL,
	`started_at` text NOT NULL,
	`transcript` text,
	`reply` text,
	`tool_calls` text DEFAULT '[]' NOT NULL,
	`timings` text DEFAULT '{}' NOT NULL,
	`error` text,
	CONSTRAINT "turns_source_check" CHECK("turns"."source" IN ('voice', 'ask', 'say')),
	CONSTRAINT "turns_outcome_check" CHECK("turns"."outcome" IN ('answered', 'no-speech', 'error', 'aborted'))
);
--> statement-breakpoint
CREATE INDEX `turns_started_at_idx` ON `turns` (`started_at`);