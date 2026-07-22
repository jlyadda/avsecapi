ALTER TABLE avsec_visitors
  CHANGE First_name first_name VARCHAR(255) NOT NULL,
  CHANGE Last_name last_name VARCHAR(255) NOT NULL,
  CHANGE NIN_number identity_number VARCHAR(100) NOT NULL,
  CHANGE Date_Of_birth date_of_birth DATE NOT NULL,
  CHANGE Company company VARCHAR(255) DEFAULT NULL,
  CHANGE Company_position company_position VARCHAR(255) DEFAULT NULL,
  CHANGE Visitor_image_url image_url TEXT DEFAULT NULL,
  CHANGE Visitor_Status security_status ENUM('ACTIVE','BLOCKED','FLAGGED') NOT NULL DEFAULT 'ACTIVE',
  CHANGE Gender gender ENUM('MALE','FEMALE','OTHER','UNDISCLOSED') DEFAULT 'UNDISCLOSED',
  CHANGE Last_visit last_visit DATE DEFAULT NULL,
  ADD COLUMN identity_type ENUM('NIN','PASSPORT','OTHER') NOT NULL DEFAULT 'NIN' AFTER last_name,
  ADD COLUMN issuing_country CHAR(2) NOT NULL DEFAULT 'UG' AFTER identity_number,
  DROP INDEX Avsec_visitors_NIN_number_key,
  ADD UNIQUE KEY avsec_visitors_identity_key (identity_type, issuing_country, identity_number);

CREATE TABLE visitor_applications (
  id CHAR(36) NOT NULL,
  application_number VARCHAR(40) NOT NULL,
  visitor_id BIGINT(20) NOT NULL,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(50) NOT NULL,
  company VARCHAR(255) DEFAULT NULL,
  company_position VARCHAR(255) DEFAULT NULL,
  purpose TEXT NOT NULL,
  host_name VARCHAR(255) NOT NULL,
  host_email VARCHAR(255) NOT NULL,
  expected_arrival DATETIME NOT NULL,
  expected_departure DATETIME NOT NULL,
  status ENUM('SUBMITTED','APPROVED','REJECTED','CHECKED_IN','CHECKED_OUT','CANCELLED') NOT NULL DEFAULT 'SUBMITTED',
  reviewed_by CHAR(36) DEFAULT NULL,
  reviewed_at DATETIME DEFAULT NULL,
  review_notes TEXT DEFAULT NULL,
  source_key_hash CHAR(16) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP() ON UPDATE CURRENT_TIMESTAMP(),
  PRIMARY KEY (id),
  UNIQUE KEY visitor_applications_number_key (application_number),
  UNIQUE KEY visitor_applications_schedule_key (visitor_id, expected_arrival),
  KEY visitor_applications_status_arrival_idx (status, expected_arrival),
  KEY visitor_applications_reviewed_by_idx (reviewed_by),
  CONSTRAINT visitor_applications_visitor_fkey
    FOREIGN KEY (visitor_id) REFERENCES avsec_visitors (id),
  CONSTRAINT visitor_applications_reviewed_by_fkey
    FOREIGN KEY (reviewed_by) REFERENCES user_profiles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE visit_sessions
  DROP FOREIGN KEY Visit_SEssions_Created_by_fkey;

ALTER TABLE visit_sessions
  CHANGE created_at created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  CHANGE Started_at checked_in_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  CHANGE Ended_at checked_out_at DATETIME DEFAULT NULL,
  CHANGE Created_by checked_in_by CHAR(36) DEFAULT NULL,
  ADD COLUMN application_id CHAR(36) NOT NULL AFTER id,
  ADD COLUMN visitor_id BIGINT(20) NOT NULL AFTER application_id,
  ADD COLUMN checked_out_by CHAR(36) DEFAULT NULL AFTER checked_in_by,
  ADD COLUMN gate VARCHAR(100) DEFAULT NULL AFTER checked_out_by,
  ADD COLUMN status ENUM('CHECKED_IN','CHECKED_OUT') NOT NULL DEFAULT 'CHECKED_IN' AFTER gate,
  ADD UNIQUE KEY visit_sessions_application_key (application_id),
  ADD KEY visit_sessions_visitor_idx (visitor_id),
  ADD KEY visit_sessions_checked_out_by_idx (checked_out_by),
  ADD CONSTRAINT visit_sessions_checked_in_by_fkey
    FOREIGN KEY (checked_in_by) REFERENCES user_profiles (id) ON DELETE SET NULL,
  ADD CONSTRAINT visit_sessions_application_fkey
    FOREIGN KEY (application_id) REFERENCES visitor_applications (id),
  ADD CONSTRAINT visit_sessions_visitor_fkey
    FOREIGN KEY (visitor_id) REFERENCES avsec_visitors (id),
  ADD CONSTRAINT visit_sessions_checked_out_by_fkey
    FOREIGN KEY (checked_out_by) REFERENCES user_profiles (id) ON DELETE SET NULL;
