CREATE TABLE `email_submission` (
	`id` text PRIMARY KEY NOT NULL,
	`identity_id` text NOT NULL,
	`email_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`envelope_mail_from` text NOT NULL,
	`envelope_rcpt_to` text NOT NULL,
	`send_at` integer NOT NULL,
	`undo_status` text DEFAULT 'final' NOT NULL,
	`delivery_status` text,
	`provider_message_id` text
);
--> statement-breakpoint
CREATE INDEX `email_submission_email_idx` ON `email_submission` (`email_id`);--> statement-breakpoint
CREATE TABLE `identity_setting` (
	`address` text PRIMARY KEY NOT NULL,
	`name` text,
	`reply_to` text,
	`bcc` text,
	`text_signature` text,
	`html_signature` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `change_log` ADD `counts_only` integer DEFAULT 0 NOT NULL;