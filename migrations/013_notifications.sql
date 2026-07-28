CREATE TABLE notification_templates (
  id CHAR(36) NOT NULL,
  code VARCHAR(100) NOT NULL,
  name VARCHAR(150) NOT NULL,
  title_template VARCHAR(255) NOT NULL,
  body_template TEXT NOT NULL,
  default_priority ENUM('LOW','NORMAL','HIGH','CRITICAL') NOT NULL DEFAULT 'NORMAL',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY notification_templates_code_key (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE notification_groups (
  id CHAR(36) NOT NULL,
  name VARCHAR(150) NOT NULL,
  description VARCHAR(500) DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by CHAR(36) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY notification_groups_name_key (name),
  CONSTRAINT notification_groups_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES user_profiles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE notification_group_members (
  group_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  added_by CHAR(36) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (group_id, user_id),
  KEY notification_group_members_user_idx (user_id),
  CONSTRAINT notification_group_members_group_fkey
    FOREIGN KEY (group_id) REFERENCES notification_groups (id) ON DELETE CASCADE,
  CONSTRAINT notification_group_members_user_fkey
    FOREIGN KEY (user_id) REFERENCES user_profiles (id) ON DELETE CASCADE,
  CONSTRAINT notification_group_members_added_by_fkey
    FOREIGN KEY (added_by) REFERENCES user_profiles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE notifications (
  id CHAR(36) NOT NULL,
  source ENUM('USER','SYSTEM') NOT NULL,
  type VARCHAR(100) NOT NULL,
  title VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  priority ENUM('LOW','NORMAL','HIGH','CRITICAL') NOT NULL DEFAULT 'NORMAL',
  actor_id CHAR(36) DEFAULT NULL,
  request_id CHAR(36) NOT NULL,
  resource_type VARCHAR(100) DEFAULT NULL,
  resource_id VARCHAR(100) DEFAULT NULL,
  channels JSON NOT NULL,
  metadata JSON NOT NULL,
  scheduled_at DATETIME(3) DEFAULT NULL,
  expires_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY notifications_created_idx (created_at),
  KEY notifications_resource_idx (resource_type, resource_id),
  KEY notifications_actor_idx (actor_id),
  KEY notifications_scheduled_idx (scheduled_at),
  CONSTRAINT notifications_actor_fkey
    FOREIGN KEY (actor_id) REFERENCES user_profiles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE notification_targets (
  id CHAR(36) NOT NULL,
  notification_id CHAR(36) NOT NULL,
  target_type ENUM('ALL','ROLE','DEPARTMENT','GROUP','USER','EXTERNAL_EMAIL') NOT NULL,
  target_value VARCHAR(255) DEFAULT NULL,
  PRIMARY KEY (id),
  KEY notification_targets_notification_idx (notification_id),
  CONSTRAINT notification_targets_notification_fkey
    FOREIGN KEY (notification_id) REFERENCES notifications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE notification_recipients (
  notification_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  delivered_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  read_at DATETIME(3) DEFAULT NULL,
  archived_at DATETIME(3) DEFAULT NULL,
  PRIMARY KEY (notification_id, user_id),
  KEY notification_recipients_user_read_idx (user_id, read_at, archived_at),
  CONSTRAINT notification_recipients_notification_fkey
    FOREIGN KEY (notification_id) REFERENCES notifications (id) ON DELETE CASCADE,
  CONSTRAINT notification_recipients_user_fkey
    FOREIGN KEY (user_id) REFERENCES user_profiles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE notification_deliveries (
  id CHAR(36) NOT NULL,
  notification_id CHAR(36) NOT NULL,
  user_id CHAR(36) DEFAULT NULL,
  recipient_email VARCHAR(255) DEFAULT NULL,
  channel ENUM('IN_APP','EMAIL') NOT NULL,
  status ENUM('PENDING','SENT','FAILED','SKIPPED') NOT NULL DEFAULT 'PENDING',
  attempt_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
  last_error VARCHAR(500) DEFAULT NULL,
  available_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  sent_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY notification_deliveries_pending_idx (status, available_at),
  KEY notification_deliveries_notification_idx (notification_id),
  KEY notification_deliveries_user_idx (user_id),
  CONSTRAINT notification_deliveries_notification_fkey
    FOREIGN KEY (notification_id) REFERENCES notifications (id) ON DELETE CASCADE,
  CONSTRAINT notification_deliveries_user_fkey
    FOREIGN KEY (user_id) REFERENCES user_profiles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE notification_outbox (
  id CHAR(36) NOT NULL,
  notification_id CHAR(36) NOT NULL,
  status ENUM('PENDING','PROCESSING','COMPLETED','FAILED') NOT NULL DEFAULT 'PENDING',
  attempt_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
  available_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  processed_at DATETIME(3) DEFAULT NULL,
  last_error VARCHAR(500) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY notification_outbox_notification_key (notification_id),
  KEY notification_outbox_pending_idx (status, available_at),
  CONSTRAINT notification_outbox_notification_fkey
    FOREIGN KEY (notification_id) REFERENCES notifications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO notification_templates
  (id, code, name, title_template, body_template, default_priority)
VALUES
  (UUID(), 'VISITOR_APPLICATION_SUBMITTED', 'Visitor application submitted',
   'New visitor application', 'Visitor application {{reference}} requires review.', 'NORMAL'),
  (UUID(), 'VISITOR_APPLICATION_DECIDED', 'Visitor application decision',
   'Visitor application {{decision}}', 'Your visitor application {{reference}} was {{decision}}.', 'NORMAL'),
  (UUID(), 'VEHICLE_APPLICATION_SUBMITTED', 'Vehicle application submitted',
   'New vehicle access application', 'Vehicle permit {{reference}} requires review.', 'NORMAL'),
  (UUID(), 'ACCESS_CARD_ALERT', 'Access card alert',
   'Access card {{status}}', 'Access card {{number}} was marked {{status}}.', 'HIGH'),
  (UUID(), 'SYSTEM_USER_CREATED', 'System user created',
   'Your AVSEC account is ready', 'An AVSEC account was created for you.', 'NORMAL');
