-- Hand-written (drizzle-kit generate --custom): triggers for the JMAP layer.
-- 1. Membership/keyword triggers now mark their Mailbox "updated" entries counts_only = 1,
--    so Mailbox/changes can report updatedProperties = counts when nothing else changed.
-- 2. EmailSubmission and Identity change-log triggers.

DROP TRIGGER `email_mailbox_ai`;
--> statement-breakpoint
DROP TRIGGER `email_mailbox_ad`;
--> statement-breakpoint
DROP TRIGGER `email_keyword_ai`;
--> statement-breakpoint
DROP TRIGGER `email_keyword_ad`;
--> statement-breakpoint
CREATE TRIGGER `email_mailbox_ai` AFTER INSERT ON `email_mailbox` BEGIN
	INSERT INTO change_log (type, object_id, kind, counts_only) VALUES ('Mailbox', NEW.mailbox_id, 'updated', 1);
	INSERT INTO change_log (type, object_id, kind) VALUES ('Email', NEW.email_id, 'updated');
END;
--> statement-breakpoint
CREATE TRIGGER `email_mailbox_ad` AFTER DELETE ON `email_mailbox` BEGIN
	INSERT INTO change_log (type, object_id, kind, counts_only) VALUES ('Mailbox', OLD.mailbox_id, 'updated', 1);
	INSERT INTO change_log (type, object_id, kind) VALUES ('Email', OLD.email_id, 'updated');
END;
--> statement-breakpoint
CREATE TRIGGER `email_keyword_ai` AFTER INSERT ON `email_keyword` BEGIN
	INSERT INTO change_log (type, object_id, kind) VALUES ('Email', NEW.email_id, 'updated');
	INSERT INTO change_log (type, object_id, kind, counts_only)
		SELECT 'Mailbox', mailbox_id, 'updated', 1 FROM email_mailbox
		WHERE email_id = NEW.email_id AND NEW.keyword IN ('$seen', '$draft');
END;
--> statement-breakpoint
CREATE TRIGGER `email_keyword_ad` AFTER DELETE ON `email_keyword` BEGIN
	INSERT INTO change_log (type, object_id, kind) VALUES ('Email', OLD.email_id, 'updated');
	INSERT INTO change_log (type, object_id, kind, counts_only)
		SELECT 'Mailbox', mailbox_id, 'updated', 1 FROM email_mailbox
		WHERE email_id = OLD.email_id AND OLD.keyword IN ('$seen', '$draft');
END;
--> statement-breakpoint

CREATE TRIGGER `email_submission_ai` AFTER INSERT ON `email_submission` BEGIN
	INSERT INTO change_log (type, object_id, kind) VALUES ('EmailSubmission', NEW.id, 'created');
END;
--> statement-breakpoint
CREATE TRIGGER `email_submission_au` AFTER UPDATE ON `email_submission` BEGIN
	INSERT INTO change_log (type, object_id, kind) VALUES ('EmailSubmission', NEW.id, 'updated');
END;
--> statement-breakpoint
CREATE TRIGGER `email_submission_ad` AFTER DELETE ON `email_submission` BEGIN
	INSERT INTO change_log (type, object_id, kind) VALUES ('EmailSubmission', OLD.id, 'destroyed');
END;
--> statement-breakpoint
CREATE TRIGGER `identity_setting_ai` AFTER INSERT ON `identity_setting` BEGIN
	INSERT INTO change_log (type, object_id, kind) VALUES ('Identity', NEW.address, 'updated');
END;
--> statement-breakpoint
CREATE TRIGGER `identity_setting_au` AFTER UPDATE ON `identity_setting` BEGIN
	INSERT INTO change_log (type, object_id, kind) VALUES ('Identity', NEW.address, 'updated');
END;
