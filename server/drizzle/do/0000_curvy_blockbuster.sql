CREATE TABLE `change_log` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`object_id` text NOT NULL,
	`kind` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `change_log_type_seq_idx` ON `change_log` (`type`,`seq`);--> statement-breakpoint
CREATE TABLE `email` (
	`id` text PRIMARY KEY NOT NULL,
	`blob_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`size` integer NOT NULL,
	`received_at` integer NOT NULL,
	`sent_at` integer,
	`message_id` text,
	`in_reply_to` text,
	`references` text,
	`subject` text,
	`from` text,
	`sender` text,
	`to` text,
	`cc` text,
	`bcc` text,
	`reply_to` text,
	`preview` text DEFAULT '' NOT NULL,
	`has_attachment` integer DEFAULT false NOT NULL,
	`body_structure` text,
	`text_body` text,
	`html_body` text,
	`attachments` text,
	`parse_state` text DEFAULT 'pending' NOT NULL,
	`parse_attempts` integer DEFAULT 0 NOT NULL,
	`parse_error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_blob_uq` ON `email` (`blob_id`);--> statement-breakpoint
CREATE INDEX `email_thread_idx` ON `email` (`thread_id`);--> statement-breakpoint
CREATE INDEX `email_received_idx` ON `email` (`received_at`);--> statement-breakpoint
CREATE INDEX `email_message_id_idx` ON `email` (`message_id`);--> statement-breakpoint
CREATE INDEX `email_parse_state_idx` ON `email` (`parse_state`);--> statement-breakpoint
CREATE TABLE `email_keyword` (
	`email_id` text NOT NULL,
	`keyword` text NOT NULL,
	PRIMARY KEY(`email_id`, `keyword`),
	FOREIGN KEY (`email_id`) REFERENCES `email`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `email_keyword_kw_idx` ON `email_keyword` (`keyword`,`email_id`);--> statement-breakpoint
CREATE TABLE `email_mailbox` (
	`email_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	PRIMARY KEY(`email_id`, `mailbox_id`),
	FOREIGN KEY (`email_id`) REFERENCES `email`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `email_mailbox_mb_idx` ON `email_mailbox` (`mailbox_id`,`email_id`);--> statement-breakpoint
CREATE TABLE `mailbox` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`parent_id` text,
	`role` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_subscribed` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailbox_role_uq` ON `mailbox` (`role`) WHERE role is not null;--> statement-breakpoint
CREATE INDEX `mailbox_parent_idx` ON `mailbox` (`parent_id`);--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `thread_ref` (
	`message_id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `thread_ref_thread_idx` ON `thread_ref` (`thread_id`);