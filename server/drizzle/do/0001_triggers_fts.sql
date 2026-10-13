-- Hand-written (drizzle-kit generate --custom): FTS5 index and change-log triggers.
-- Not expressible in the Drizzle schema. Each statement is separated by a breakpoint
-- because trigger bodies contain semicolons.
--
-- Change-log semantics for Foo/changes (RFC 8620 5.2): entries for an object between two
-- states collapse as: last kind = destroyed -> destroyed (or nothing if its first entry in
-- the window is "created"); else first kind = created -> created; else updated. A single
-- logical change may log several entries (e.g. delivery logs Email created + updated).

-- Full-text index. rowid = email.rowid. Filled by the parse alarm, so unparsed
-- messages are not searchable by body yet (their subject/from/to are only indexed then too).
CREATE VIRTUAL TABLE `email_fts` USING fts5(
	subject, sender, recipients, body,
	tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint

-- Email -------------------------------------------------------------------------------
CREATE TRIGGER `email_ai` AFTER INSERT ON `email` BEGIN
	INSERT INTO change_log (type, object_id, kind) VALUES ('Email', NEW.id, 'created');
	INSERT INTO change_log (type, object_id, kind) VALUES ('Thread', NEW.thread_id,
		CASE WHEN EXISTS (SELECT 1 FROM email WHERE thread_id = NEW.thread_id AND id <> NEW.id)
			THEN 'updated' ELSE 'created' END);
END;
--> statement-breakpoint
-- Body-derived properties (preview, hasAttachment, bodyStructure, ...) appear on parse.
CREATE TRIGGER `email_au_parsed` AFTER UPDATE OF parse_state ON `email`
WHEN NEW.parse_state = 'parsed' AND OLD.parse_state <> 'parsed' BEGIN
	INSERT INTO change_log (type, object_id, kind) VALUES ('Email', NEW.id, 'updated');
END;
--> statement-breakpoint
CREATE TRIGGER `email_ad` AFTER DELETE ON `email` BEGIN
	INSERT INTO change_log (type, object_id, kind) VALUES ('Email', OLD.id, 'destroyed');
	INSERT INTO change_log (type, object_id, kind) VALUES ('Thread', OLD.thread_id,
		CASE WHEN EXISTS (SELECT 1 FROM email WHERE thread_id = OLD.thread_id)
			THEN 'updated' ELSE 'destroyed' END);
	-- Thread ids must not be reused once destroyed: forget its Message-IDs.
	DELETE FROM thread_ref WHERE thread_id = OLD.thread_id
		AND NOT EXISTS (SELECT 1 FROM email WHERE thread_id = OLD.thread_id);
	DELETE FROM email_fts WHERE rowid = OLD.rowid;
END;
--> statement-breakpoint

-- Mailbox -----------------------------------------------------------------------------
CREATE TRIGGER `mailbox_ai` AFTER INSERT ON `mailbox` BEGIN
	INSERT INTO change_log (type, object_id, kind) VALUES ('Mailbox', NEW.id, 'created');
END;
--> statement-breakpoint
CREATE TRIGGER `mailbox_au` AFTER UPDATE ON `mailbox` BEGIN
	INSERT INTO change_log (type, object_id, kind) VALUES ('Mailbox', NEW.id, 'updated');
END;
--> statement-breakpoint
CREATE TRIGGER `mailbox_ad` AFTER DELETE ON `mailbox` BEGIN
	INSERT INTO change_log (type, object_id, kind) VALUES ('Mailbox', OLD.id, 'destroyed');
END;
--> statement-breakpoint

-- Membership: Email.mailboxIds changes, and the mailbox's counts change ---------------
CREATE TRIGGER `email_mailbox_ai` AFTER INSERT ON `email_mailbox` BEGIN
	INSERT INTO change_log (type, object_id, kind) VALUES ('Mailbox', NEW.mailbox_id, 'updated');
	INSERT INTO change_log (type, object_id, kind) VALUES ('Email', NEW.email_id, 'updated');
END;
--> statement-breakpoint
CREATE TRIGGER `email_mailbox_ad` AFTER DELETE ON `email_mailbox` BEGIN
	INSERT INTO change_log (type, object_id, kind) VALUES ('Mailbox', OLD.mailbox_id, 'updated');
	INSERT INTO change_log (type, object_id, kind) VALUES ('Email', OLD.email_id, 'updated');
END;
--> statement-breakpoint

-- Keywords: Email.keywords changes; $seen/$draft also move unreadEmails/unreadThreads of
-- every mailbox the email is in (RFC 8621 2: unread = neither $seen nor $draft). ----------
CREATE TRIGGER `email_keyword_ai` AFTER INSERT ON `email_keyword` BEGIN
	INSERT INTO change_log (type, object_id, kind) VALUES ('Email', NEW.email_id, 'updated');
	INSERT INTO change_log (type, object_id, kind)
		SELECT 'Mailbox', mailbox_id, 'updated' FROM email_mailbox
		WHERE email_id = NEW.email_id AND NEW.keyword IN ('$seen', '$draft');
END;
--> statement-breakpoint
CREATE TRIGGER `email_keyword_ad` AFTER DELETE ON `email_keyword` BEGIN
	INSERT INTO change_log (type, object_id, kind) VALUES ('Email', OLD.email_id, 'updated');
	INSERT INTO change_log (type, object_id, kind)
		SELECT 'Mailbox', mailbox_id, 'updated' FROM email_mailbox
		WHERE email_id = OLD.email_id AND OLD.keyword IN ('$seen', '$draft');
END;
