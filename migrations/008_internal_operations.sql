ALTER TABLE access_cards
  DROP FOREIGN KEY access_cards_current_visitor_id_fkey,
  DROP COLUMN current_visitor_id,
  ADD COLUMN current_application_id CHAR(36) DEFAULT NULL AFTER category,
  ADD UNIQUE KEY access_cards_current_application_key (current_application_id),
  ADD CONSTRAINT access_cards_current_application_fkey
    FOREIGN KEY (current_application_id) REFERENCES visitor_applications (id) ON DELETE SET NULL;

CREATE TABLE card_assignments (
  id CHAR(36) NOT NULL,
  card_id CHAR(36) NOT NULL,
  application_id CHAR(36) NOT NULL,
  assigned_by CHAR(36) DEFAULT NULL,
  assigned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  returned_by CHAR(36) DEFAULT NULL,
  returned_at DATETIME DEFAULT NULL,
  return_condition ENUM('GOOD','DAMAGED','LOST') DEFAULT NULL,
  status ENUM('ACTIVE','RETURNED') NOT NULL DEFAULT 'ACTIVE',
  PRIMARY KEY (id),
  KEY card_assignments_card_status_idx (card_id, status),
  KEY card_assignments_application_status_idx (application_id, status),
  KEY card_assignments_assigned_by_idx (assigned_by),
  KEY card_assignments_returned_by_idx (returned_by),
  CONSTRAINT card_assignments_card_fkey
    FOREIGN KEY (card_id) REFERENCES access_cards (id),
  CONSTRAINT card_assignments_application_fkey
    FOREIGN KEY (application_id) REFERENCES visitor_applications (id),
  CONSTRAINT card_assignments_assigned_by_fkey
    FOREIGN KEY (assigned_by) REFERENCES user_profiles (id) ON DELETE SET NULL,
  CONSTRAINT card_assignments_returned_by_fkey
    FOREIGN KEY (returned_by) REFERENCES user_profiles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE card_events (
  id CHAR(36) NOT NULL,
  card_id CHAR(36) NOT NULL,
  application_id CHAR(36) DEFAULT NULL,
  event_type ENUM(
    'CREATED','ASSIGNED','RETURNED','MARKED_AVAILABLE',
    'MARKED_UNAVAILABLE','MARKED_DAMAGED','MARKED_LOST'
  ) NOT NULL,
  performed_by CHAR(36) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (id),
  KEY card_events_card_created_idx (card_id, created_at),
  KEY card_events_application_idx (application_id),
  KEY card_events_performed_by_idx (performed_by),
  CONSTRAINT card_events_card_fkey
    FOREIGN KEY (card_id) REFERENCES access_cards (id),
  CONSTRAINT card_events_application_fkey
    FOREIGN KEY (application_id) REFERENCES visitor_applications (id) ON DELETE SET NULL,
  CONSTRAINT card_events_performed_by_fkey
    FOREIGN KEY (performed_by) REFERENCES user_profiles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX visitor_applications_visit_dates_idx
  ON visitor_applications (visit_starts, visit_ends);

CREATE INDEX visitor_applications_company_idx
  ON visitor_applications (company_name);
