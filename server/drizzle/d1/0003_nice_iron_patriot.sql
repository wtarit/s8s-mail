-- Password authentication uses OPAQUE exclusively. Discard disposable test password hashes.
DELETE FROM `account` WHERE `provider_id` = 'credential';
--> statement-breakpoint
CREATE TABLE `opaque_challenge` (
	`id` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`user_id` text,
	`session_id` text,
	`encrypted_state` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `opaque_challenge_expiry_idx` ON `opaque_challenge` (`expires_at`);--> statement-breakpoint
CREATE INDEX `opaque_challenge_user_idx` ON `opaque_challenge` (`user_id`);--> statement-breakpoint
CREATE TABLE `opaque_credential` (
	`user_id` text PRIMARY KEY NOT NULL,
	`registration_record` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pending_sign_in` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`password_verified_at` integer,
	`recovery_verified_at` integer,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pending_sign_in_user_idx` ON `pending_sign_in` (`user_id`);--> statement-breakpoint
CREATE INDEX `pending_sign_in_expiry_idx` ON `pending_sign_in` (`expires_at`);--> statement-breakpoint
ALTER TABLE `invite` ADD `claim_id` text;--> statement-breakpoint
ALTER TABLE `session` ADD `password_verified_at` integer;--> statement-breakpoint
ALTER TABLE `session` ADD `passkey_verified_at` integer;--> statement-breakpoint
ALTER TABLE `session` ADD `recovery_verified_at` integer;--> statement-breakpoint
ALTER TABLE `session` ADD `invite_id` text;