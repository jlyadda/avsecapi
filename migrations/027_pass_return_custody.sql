CREATE TABLE pass_return_settings (
  id TINYINT UNSIGNED NOT NULL,
  max_hold_hours SMALLINT UNSIGNED NOT NULL DEFAULT 12,
  updated_by CHAR(36) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT pass_return_settings_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES user_profiles (id) ON DELETE SET NULL,
  CONSTRAINT pass_return_settings_singleton CHECK (id = 1),
  CONSTRAINT pass_return_settings_hours_check CHECK (max_hold_hours BETWEEN 1 AND 168)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO pass_return_settings (id, max_hold_hours) VALUES (1, 12);

ALTER TABLE card_assignments
  ADD COLUMN due_at DATETIME(3) DEFAULT NULL AFTER assigned_at,
  ADD COLUMN retained_identity_type VARCHAR(50) DEFAULT NULL AFTER due_at,
  ADD COLUMN retained_identity_number_last4 VARCHAR(4) DEFAULT NULL
    AFTER retained_identity_type,
  ADD COLUMN identity_retained_at DATETIME(3) DEFAULT NULL
    AFTER retained_identity_number_last4,
  ADD COLUMN identity_released_at DATETIME(3) DEFAULT NULL AFTER identity_retained_at,
  ADD COLUMN identity_released_by CHAR(36) DEFAULT NULL AFTER identity_released_at,
  ADD KEY card_assignments_due_status_idx (status, due_at),
  ADD KEY card_assignments_identity_released_by_idx (identity_released_by),
  ADD CONSTRAINT card_assignments_identity_released_by_fkey
    FOREIGN KEY (identity_released_by) REFERENCES user_profiles (id) ON DELETE SET NULL;

UPDATE card_assignments assignment
INNER JOIN visitor_applications application ON application.id = assignment.application_id
INNER JOIN avsec_visitors profile ON profile.id = application.visitor_id
SET assignment.due_at = DATE_ADD(assignment.assigned_at, INTERVAL 12 HOUR),
    assignment.retained_identity_type = COALESCE(profile.identity_type, 'UNKNOWN'),
    assignment.retained_identity_number_last4 = COALESCE(RIGHT(profile.identity_number, 4), 'UNKN'),
    assignment.identity_retained_at = assignment.assigned_at,
    assignment.identity_released_at = assignment.returned_at,
    assignment.identity_released_by = assignment.returned_by;

ALTER TABLE card_assignments
  MODIFY due_at DATETIME(3) NOT NULL,
  MODIFY retained_identity_type VARCHAR(50) NOT NULL,
  MODIFY retained_identity_number_last4 VARCHAR(4) NOT NULL,
  MODIFY identity_retained_at DATETIME(3) NOT NULL;
