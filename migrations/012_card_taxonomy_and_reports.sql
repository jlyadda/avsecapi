CREATE TABLE card_access_levels (
  id CHAR(36) NOT NULL,
  code VARCHAR(50) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(500) DEFAULT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by CHAR(36) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY card_access_levels_code_key (code),
  CONSTRAINT card_access_levels_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES user_profiles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE card_categories (
  id CHAR(36) NOT NULL,
  code VARCHAR(50) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(500) DEFAULT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by CHAR(36) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY card_categories_code_key (code),
  CONSTRAINT card_categories_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES user_profiles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO card_access_levels (id, code, name, sort_order)
VALUES
  (UUID(), 'LEVEL_1', 'Level 1', 10),
  (UUID(), 'LEVEL_2', 'Level 2', 20),
  (UUID(), 'LEVEL_3', 'Level 3', 30),
  (UUID(), 'LEVEL_4', 'Level 4', 40),
  (UUID(), 'ALL', 'All Access Levels', 50);

INSERT INTO card_categories (id, code, name, sort_order)
VALUES
  (UUID(), 'VISITOR', 'Visitor', 10),
  (UUID(), 'STAFF', 'Staff', 20),
  (UUID(), 'CONTRACTOR', 'Contractor', 30),
  (UUID(), 'ONE_DAY_DUTY', 'One Day Duty', 40),
  (UUID(), 'PUBLIC_AREAS', 'Public Areas', 50);

ALTER TABLE access_cards
  MODIFY access_level VARCHAR(50) NOT NULL,
  MODIFY category VARCHAR(50) NOT NULL,
  ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER is_lost,
  ADD KEY access_cards_access_level_idx (access_level),
  ADD KEY access_cards_category_idx (category),
  ADD CONSTRAINT access_cards_access_level_fkey
    FOREIGN KEY (access_level) REFERENCES card_access_levels (code),
  ADD CONSTRAINT access_cards_category_fkey
    FOREIGN KEY (category) REFERENCES card_categories (code);

CREATE TABLE card_reconciliation_reports (
  id CHAR(36) NOT NULL,
  report_date DATE NOT NULL,
  generated_by CHAR(36) DEFAULT NULL,
  request_id CHAR(36) NOT NULL,
  summary JSON NOT NULL,
  notes VARCHAR(2000) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY card_reports_date_created_idx (report_date, created_at),
  KEY card_reports_generated_by_idx (generated_by),
  KEY card_reports_request_idx (request_id),
  CONSTRAINT card_reports_generated_by_fkey
    FOREIGN KEY (generated_by) REFERENCES user_profiles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE card_reconciliation_report_items (
  id CHAR(36) NOT NULL,
  report_id CHAR(36) NOT NULL,
  card_id CHAR(36) DEFAULT NULL,
  card_number VARCHAR(100) NOT NULL,
  access_level VARCHAR(50) NOT NULL,
  access_level_name VARCHAR(100) NOT NULL,
  category VARCHAR(50) NOT NULL,
  category_name VARCHAR(100) NOT NULL,
  card_status ENUM('AVAILABLE','ASSIGNED','UNAVAILABLE','DAMAGED','LOST') NOT NULL,
  assignment_id CHAR(36) DEFAULT NULL,
  application_id CHAR(36) DEFAULT NULL,
  application_number VARCHAR(40) DEFAULT NULL,
  holder_name VARCHAR(255) DEFAULT NULL,
  holder_phone VARCHAR(50) DEFAULT NULL,
  assigned_at DATETIME(3) DEFAULT NULL,
  last_event_at DATETIME(3) DEFAULT NULL,
  PRIMARY KEY (id),
  KEY card_report_items_report_idx (report_id),
  KEY card_report_items_card_idx (card_id),
  KEY card_report_items_status_idx (report_id, card_status),
  CONSTRAINT card_report_items_report_fkey
    FOREIGN KEY (report_id) REFERENCES card_reconciliation_reports (id) ON DELETE CASCADE,
  CONSTRAINT card_report_items_card_fkey
    FOREIGN KEY (card_id) REFERENCES access_cards (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
