ALTER TABLE user_profiles
  ADD COLUMN phone VARCHAR(50) DEFAULT NULL AFTER email;

ALTER TABLE notification_targets
  MODIFY target_type ENUM(
    'ALL','ROLE','DEPARTMENT','GROUP','USER','EXTERNAL_EMAIL','EXTERNAL_SMS'
  ) NOT NULL;

ALTER TABLE notification_deliveries
  ADD COLUMN recipient_phone VARCHAR(50) DEFAULT NULL AFTER recipient_email,
  ADD COLUMN provider_message_id VARCHAR(255) DEFAULT NULL AFTER last_error,
  MODIFY channel ENUM('IN_APP','EMAIL','SMS') NOT NULL;
