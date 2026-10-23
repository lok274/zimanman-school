CREATE TABLE `classes` (
	`code` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`assignment_json` text NOT NULL,
	`expires_at` integer NOT NULL,
	`request_id` text NOT NULL,
	`payload_hash` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `classes_owner_request` ON `classes` (`owner_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `classes_expiry` ON `classes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`alias` text NOT NULL,
	`alias_key` text NOT NULL,
	`token_hash` text NOT NULL,
	`request_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	FOREIGN KEY (`code`) REFERENCES `classes`(`code`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `members_alias` ON `members` (`code`,`alias_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `members_token` ON `members` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `members_request` ON `members` (`code`,`request_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text NOT NULL,
	`member_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`mistakes` integer,
	`elapsed_ms` integer,
	`reason` text,
	`submitted_at` integer NOT NULL,
	PRIMARY KEY(`member_id`, `id`),
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runs_member_score` ON `runs` (`member_id`,`mistakes`,`elapsed_ms`);