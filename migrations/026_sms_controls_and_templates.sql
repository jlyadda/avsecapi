ALTER TABLE notification_email_categories
  ADD COLUMN sms_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER email_enabled;

UPDATE notification_email_categories
SET sms_enabled = 1
WHERE code IN ('APPROVAL_WORKFLOWS', 'VEHICLE_APPLICATIONS');

ALTER TABLE notification_deliveries
  ADD COLUMN content_override TEXT DEFAULT NULL AFTER provider_message_id;

CREATE TABLE notification_sms_recipient_settings (
  code VARCHAR(80) NOT NULL,
  name VARCHAR(150) NOT NULL,
  description VARCHAR(500) DEFAULT NULL,
  sms_enabled TINYINT(1) NOT NULL DEFAULT 1,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  updated_by CHAR(36) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (code),
  CONSTRAINT notification_sms_recipient_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES user_profiles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO notification_sms_recipient_settings
  (code, name, description)
VALUES
  ('VISITOR_APPLICANT', 'Visitor Applicants',
   'Applicants receiving final visitor application decisions'),
  ('VEHICLE_APPLICANT', 'Vehicle Permit Applicants',
   'Accepted drivers receiving vehicle access application decisions');

CREATE TABLE notification_sms_templates (
  id CHAR(36) NOT NULL,
  code VARCHAR(100) NOT NULL,
  category_code VARCHAR(80) NOT NULL,
  recipient_type VARCHAR(80) NOT NULL,
  name VARCHAR(150) NOT NULL,
  body_template VARCHAR(918) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  created_by CHAR(36) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY notification_sms_templates_code_key (code),
  KEY notification_sms_templates_category_idx (category_code, is_active),
  KEY notification_sms_templates_recipient_idx (recipient_type, is_active),
  CONSTRAINT notification_sms_templates_category_fkey
    FOREIGN KEY (category_code) REFERENCES notification_email_categories (code),
  CONSTRAINT notification_sms_templates_recipient_fkey
    FOREIGN KEY (recipient_type) REFERENCES notification_sms_recipient_settings (code),
  CONSTRAINT notification_sms_templates_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES user_profiles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO notification_sms_templates
  (id, code, category_code, recipient_type, name, body_template, is_system)
VALUES
  (UUID(), 'VISITOR_WORKFLOW_COMPLETED', 'APPROVAL_WORKFLOWS',
   'VISITOR_APPLICANT', 'Visitor application decision SMS',
   'AVSEC: Your visitor application {{reference}} was {{decision}}.', 1),
  (UUID(), 'VEHICLE_APPLICATION_DECIDED', 'VEHICLE_APPLICATIONS',
   'VEHICLE_APPLICANT', 'Vehicle application decision SMS',
   'AVSEC: Your vehicle access application {{reference}} was {{decision}}.', 1);
