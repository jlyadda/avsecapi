ALTER TABLE notification_templates
  ADD COLUMN email_enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER is_active;
