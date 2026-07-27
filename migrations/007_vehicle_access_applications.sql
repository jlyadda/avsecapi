ALTER TABLE external_api_keys
  MODIFY api_role ENUM('VISITOR_APPLICATION','VEHICLE_ACCESS_APPLICATION') NOT NULL;

CREATE TABLE vehicle_access_applications (
  id CHAR(36) NOT NULL,
  reference VARCHAR(20) NOT NULL,
  driver_visitor_id BIGINT(20) NOT NULL,
  driver_name VARCHAR(255) NOT NULL,
  vehicle_registration_number VARCHAR(30) NOT NULL,
  vehicle_type VARCHAR(100) NOT NULL,
  company VARCHAR(255) NOT NULL,
  reason_for_access TEXT NOT NULL,
  access_gate VARCHAR(100) NOT NULL,
  date_of_access DATE NOT NULL,
  time_of_access TIME NOT NULL,
  duration_of_access_hours SMALLINT UNSIGNED NOT NULL,
  access_starts_at DATETIME NOT NULL,
  access_ends_at DATETIME NOT NULL,
  application_date DATE NOT NULL DEFAULT (CURDATE()),
  status ENUM('SUBMITTED','APPROVED','REJECTED','CANCELLED','USED') NOT NULL DEFAULT 'SUBMITTED',
  review_notes TEXT DEFAULT NULL,
  reviewed_by CHAR(36) DEFAULT NULL,
  reviewed_at DATETIME DEFAULT NULL,
  external_api_key_id CHAR(36) DEFAULT NULL,
  source_key_hash VARCHAR(16) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP() ON UPDATE CURRENT_TIMESTAMP(),
  PRIMARY KEY (id),
  UNIQUE KEY vehicle_access_reference_key (reference),
  UNIQUE KEY vehicle_access_vehicle_date_key (vehicle_registration_number, date_of_access),
  KEY vehicle_access_driver_idx (driver_visitor_id),
  KEY vehicle_access_status_start_idx (status, access_starts_at),
  KEY vehicle_access_reviewed_by_idx (reviewed_by),
  KEY vehicle_access_external_key_idx (external_api_key_id),
  CONSTRAINT vehicle_access_driver_fkey
    FOREIGN KEY (driver_visitor_id) REFERENCES avsec_visitors (id),
  CONSTRAINT vehicle_access_reviewed_by_fkey
    FOREIGN KEY (reviewed_by) REFERENCES user_profiles (id) ON DELETE SET NULL,
  CONSTRAINT vehicle_access_external_key_fkey
    FOREIGN KEY (external_api_key_id) REFERENCES external_api_keys (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
