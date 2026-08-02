DROP TABLE visitors;

CREATE TABLE visitors (
  id CHAR(36) NOT NULL,
  application_id CHAR(36) NOT NULL,
  visitor_profile_id BIGINT(20) NOT NULL,
  application_number VARCHAR(40) NOT NULL,
  full_name VARCHAR(765) NOT NULL,
  company VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(50) NOT NULL,
  visit_reasons JSON NOT NULL,
  areas_of_access JSON NOT NULL,
  valid_from DATE NOT NULL,
  valid_until DATE NOT NULL,
  status ENUM('APPROVED','CHECKED_IN','CHECKED_OUT','CANCELLED','REVOKED')
    NOT NULL DEFAULT 'APPROVED',
  approved_by CHAR(36) DEFAULT NULL,
  approved_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP() ON UPDATE CURRENT_TIMESTAMP(),
  PRIMARY KEY (id),
  UNIQUE KEY visitors_application_key (application_id),
  UNIQUE KEY visitors_application_number_key (application_number),
  KEY visitors_profile_idx (visitor_profile_id),
  KEY visitors_status_validity_idx (status, valid_from, valid_until),
  KEY visitors_approved_by_idx (approved_by),
  CONSTRAINT visitors_application_fkey
    FOREIGN KEY (application_id) REFERENCES visitor_applications (id) ON DELETE CASCADE,
  CONSTRAINT visitors_profile_fkey
    FOREIGN KEY (visitor_profile_id) REFERENCES avsec_visitors (id),
  CONSTRAINT visitors_approved_by_fkey
    FOREIGN KEY (approved_by) REFERENCES user_profiles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO visitors
  (id, application_id, visitor_profile_id, application_number, full_name,
   company, email, phone, visit_reasons, areas_of_access, valid_from,
   valid_until, status, approved_by, approved_at)
SELECT UUID(), application.id, profile.id, application.application_number,
       CONCAT_WS(' ', profile.first_name, profile.other_names, profile.last_name),
       application.company_name, application.personal_email,
       application.personal_phone, application.visit_reasons,
       COALESCE(application.areas_of_access, JSON_ARRAY()),
       application.visit_starts, application.visit_ends,
       application.status, application.reviewed_by,
       COALESCE(application.reviewed_at, application.updated_at)
FROM visitor_applications application
INNER JOIN avsec_visitors profile ON profile.id = application.visitor_id
WHERE application.status IN ('APPROVED','CHECKED_IN','CHECKED_OUT','CANCELLED');
