CREATE TABLE `class_join_codes` (
	`join_code` text PRIMARY KEY NOT NULL,
	`room_code` text NOT NULL,
	FOREIGN KEY (`room_code`) REFERENCES `classes`(`code`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "class_join_codes_digits" CHECK(length("class_join_codes"."join_code") = 2 AND "class_join_codes"."join_code" GLOB '[0-9][0-9]')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `class_join_codes_room` ON `class_join_codes` (`room_code`);