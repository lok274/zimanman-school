CREATE TABLE IF NOT EXISTS `automatic_submissions` (
	`member_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`ink_json` text NOT NULL,
	`ink_bytes` integer NOT NULL,
	`elapsed_ms` integer NOT NULL,
	`submitted_at` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
