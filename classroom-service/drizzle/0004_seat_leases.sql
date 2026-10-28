CREATE TABLE `seat_leases` (
	`code` text NOT NULL,
	`seat` integer NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`code`, `seat`),
	FOREIGN KEY (`code`) REFERENCES `classes`(`code`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "seat_leases_range" CHECK("seat_leases"."seat" BETWEEN 1 AND 40)
);
