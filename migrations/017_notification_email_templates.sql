CREATE TABLE notification_email_categories (
  code VARCHAR(80) NOT NULL,
  name VARCHAR(150) NOT NULL,
  description VARCHAR(500) DEFAULT NULL,
  email_enabled TINYINT(1) NOT NULL DEFAULT 1,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by CHAR(36) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (code),
  UNIQUE KEY notification_email_categories_name_key (name),
  CONSTRAINT notification_email_categories_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES user_profiles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO notification_email_categories
  (code, name, description)
VALUES
  ('VISITOR_APPLICATIONS', 'Visitor Applications',
   'Submission and final-decision messages sent to visitors and review staff'),
  ('VEHICLE_APPLICATIONS', 'Vehicle Applications',
   'Vehicle access permit submission and decision messages'),
  ('ACCESS_CARDS', 'Access Cards',
   'Lost, damaged, unavailable, and other access-card alerts'),
  ('USER_ACCOUNTS', 'User Accounts',
   'System-user account lifecycle messages'),
  ('APPROVAL_WORKFLOWS', 'Approval Workflows',
   'Stage assignment and workflow completion messages'),
  ('GENERAL', 'General Notifications',
   'Reusable operational announcements and general messages');

ALTER TABLE notification_templates
  ADD COLUMN category_code VARCHAR(80) DEFAULT NULL AFTER code,
  ADD COLUMN is_system TINYINT(1) NOT NULL DEFAULT 0 AFTER email_enabled,
  ADD COLUMN created_by CHAR(36) DEFAULT NULL AFTER is_system;

UPDATE notification_templates
SET category_code = CASE
  WHEN code IN ('VISITOR_APPLICATION_SUBMITTED', 'VISITOR_APPLICATION_DECIDED')
    THEN 'VISITOR_APPLICATIONS'
  WHEN code = 'VEHICLE_APPLICATION_SUBMITTED'
    THEN 'VEHICLE_APPLICATIONS'
  WHEN code = 'ACCESS_CARD_ALERT'
    THEN 'ACCESS_CARDS'
  WHEN code = 'SYSTEM_USER_CREATED'
    THEN 'USER_ACCOUNTS'
  WHEN code IN ('VISITOR_WORKFLOW_STAGE_ASSIGNED', 'VISITOR_WORKFLOW_COMPLETED')
    THEN 'APPROVAL_WORKFLOWS'
  ELSE 'GENERAL'
END,
is_system = 1;

ALTER TABLE notification_templates
  MODIFY category_code VARCHAR(80) NOT NULL,
  DROP COLUMN email_enabled,
  ADD KEY notification_templates_category_idx (category_code, is_active),
  ADD KEY notification_templates_created_by_idx (created_by),
  ADD CONSTRAINT notification_templates_category_fkey
    FOREIGN KEY (category_code) REFERENCES notification_email_categories (code),
  ADD CONSTRAINT notification_templates_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES user_profiles (id) ON DELETE SET NULL;
