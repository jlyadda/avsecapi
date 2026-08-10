CREATE TABLE IF NOT EXISTS access_areas (
  code VARCHAR(80) NOT NULL,
  name VARCHAR(150) NOT NULL,
  description VARCHAR(500) DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_by CHAR(36) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (code),
  UNIQUE KEY access_areas_name_key (name),
  CONSTRAINT access_areas_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES user_profiles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO access_areas (code, name, sort_order)
VALUES
  ('PUBLIC_AREAS', 'Public Areas', 10),
  ('PASSENGER_TERMINAL', 'Passenger Terminal Building', 20),
  ('CARGO_VILLAGE', 'Cargo Village', 30),
  ('VIP', 'VIP', 40),
  ('AIRSIDE', 'Airside', 50),
  ('TOWER', 'Tower', 60)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  sort_order = VALUES(sort_order);

CREATE TABLE IF NOT EXISTS card_access_level_areas (
  access_level_code VARCHAR(50) NOT NULL,
  area_code VARCHAR(80) NOT NULL,
  assigned_by CHAR(36) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (access_level_code, area_code),
  KEY card_access_level_areas_area_idx (area_code),
  CONSTRAINT card_access_level_areas_level_fkey
    FOREIGN KEY (access_level_code) REFERENCES card_access_levels (code) ON DELETE CASCADE,
  CONSTRAINT card_access_level_areas_area_fkey
    FOREIGN KEY (area_code) REFERENCES access_areas (code),
  CONSTRAINT card_access_level_areas_assigned_by_fkey
    FOREIGN KEY (assigned_by) REFERENCES user_profiles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO card_access_level_areas (access_level_code, area_code)
SELECT level.code, area.code
FROM card_access_levels level
INNER JOIN access_areas area ON (
  (level.code = 'PTB' AND area.code = 'PASSENGER_TERMINAL')
  OR (level.code = 'LEVEL_1' AND area.code = 'PUBLIC_AREAS')
  OR (level.code = 'LEVEL_2' AND area.code = 'CARGO_VILLAGE')
  OR (level.code = 'LEVEL_3' AND area.code = 'AIRSIDE')
  OR (level.code = 'LEVEL_4' AND area.code = 'TOWER')
  OR level.code = 'ALL'
);

CREATE TABLE IF NOT EXISTS application_approved_access_areas (
  application_id CHAR(36) NOT NULL,
  area_code VARCHAR(80) NOT NULL,
  approved_by CHAR(36) DEFAULT NULL,
  approved_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (application_id, area_code),
  KEY application_approved_areas_area_idx (area_code),
  KEY application_approved_areas_officer_idx (approved_by),
  CONSTRAINT application_approved_areas_application_fkey
    FOREIGN KEY (application_id) REFERENCES visitor_applications (id) ON DELETE CASCADE,
  CONSTRAINT application_approved_areas_area_fkey
    FOREIGN KEY (area_code) REFERENCES access_areas (code),
  CONSTRAINT application_approved_areas_officer_fkey
    FOREIGN KEY (approved_by) REFERENCES user_profiles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE application_workflow_stages
  ADD COLUMN IF NOT EXISTS captures_access_approval TINYINT(1) NOT NULL DEFAULT 0 AFTER sla_hours;

UPDATE application_workflow_stages
SET captures_access_approval = 1
WHERE code = 'SENIOR_SECURITY_REVIEW';

ALTER TABLE visitors
  ADD COLUMN IF NOT EXISTS approved_areas_of_access JSON DEFAULT NULL AFTER phone;

INSERT IGNORE INTO application_approved_access_areas
  (application_id, area_code, approved_by, approved_at)
SELECT application.id,
       area.code,
       application.reviewed_by,
       COALESCE(application.reviewed_at, application.updated_at)
FROM visitor_applications application
INNER JOIN access_areas area ON (
  (area.code = 'PASSENGER_TERMINAL' AND (
    JSON_CONTAINS(application.areas_of_access, JSON_QUOTE('Terminal'))
    OR JSON_CONTAINS(application.areas_of_access, JSON_QUOTE('PTB'))
    OR JSON_CONTAINS(application.areas_of_access, JSON_QUOTE('Passenger Terminal'))
    OR JSON_CONTAINS(application.areas_of_access, JSON_QUOTE('PASSENGER_TERMINAL'))
  ))
  OR (area.code = 'VIP' AND JSON_CONTAINS(application.areas_of_access, JSON_QUOTE('Vip')))
  OR (area.code = 'VIP' AND JSON_CONTAINS(application.areas_of_access, JSON_QUOTE('VIP')))
  OR (area.code = 'AIRSIDE' AND JSON_CONTAINS(application.areas_of_access, JSON_QUOTE('Airside')))
  OR (area.code = 'AIRSIDE' AND JSON_CONTAINS(application.areas_of_access, JSON_QUOTE('AIRSIDE')))
  OR (area.code = 'PUBLIC_AREAS' AND JSON_CONTAINS(application.areas_of_access, JSON_QUOTE('Public Areas')))
  OR (area.code = 'PUBLIC_AREAS' AND JSON_CONTAINS(application.areas_of_access, JSON_QUOTE('PUBLIC_AREAS')))
  OR (area.code = 'CARGO_VILLAGE' AND JSON_CONTAINS(application.areas_of_access, JSON_QUOTE('Cargo Village')))
  OR (area.code = 'CARGO_VILLAGE' AND JSON_CONTAINS(application.areas_of_access, JSON_QUOTE('CARGO_VILLAGE')))
  OR (area.code = 'TOWER' AND JSON_CONTAINS(application.areas_of_access, JSON_QUOTE('Tower')))
  OR (area.code = 'TOWER' AND JSON_CONTAINS(application.areas_of_access, JSON_QUOTE('TOWER')))
)
WHERE application.status IN ('APPROVED','CHECKED_IN','CHECKED_OUT','CANCELLED');

UPDATE visitors visitor
SET approved_areas_of_access = COALESCE(
  (
    SELECT CONCAT(
      '[',
      GROUP_CONCAT(JSON_QUOTE(approved.area_code) ORDER BY approved.area_code SEPARATOR ','),
      ']'
    )
    FROM application_approved_access_areas approved
    WHERE approved.application_id = visitor.application_id
  ),
  JSON_ARRAY()
);

ALTER TABLE visitors
  MODIFY approved_areas_of_access JSON NOT NULL;
