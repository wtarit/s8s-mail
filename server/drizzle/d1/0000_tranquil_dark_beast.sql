CREATE TABLE `address` (
	`address` text PRIMARY KEY NOT NULL,
	`local_part` text NOT NULL,
	`domain` text NOT NULL,
	`account_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`domain`) REFERENCES `domain`(`name`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `mail_account`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `address_account_idx` ON `address` (`account_id`);--> statement-breakpoint
CREATE TABLE `domain` (
	`name` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mail_account` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`is_personal` integer DEFAULT true NOT NULL,
	`owner_user_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mail_account_owner_idx` ON `mail_account` (`owner_user_id`);