ALTER TABLE vehicle_access_applications
  ADD COLUMN used_by CHAR(36) DEFAULT NULL AFTER reviewed_at,
  ADD COLUMN used_at DATETIME(3) DEFAULT NULL AFTER used_by,
  ADD KEY vehicle_access_used_by_idx (used_by),
  ADD CONSTRAINT vehicle_access_used_by_fkey
    FOREIGN KEY (used_by) REFERENCES user_profiles (id) ON DELETE SET NULL;

CREATE TABLE audit_events (
  id CHAR(36) NOT NULL,
  occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  actor_id CHAR(36) DEFAULT NULL,
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(100) NOT NULL,
  resource_id VARCHAR(100) NOT NULL,
  request_id CHAR(36) NOT NULL,
  metadata JSON NOT NULL,
  PRIMARY KEY (id),
  KEY audit_events_occurred_idx (occurred_at),
  KEY audit_events_actor_occurred_idx (actor_id, occurred_at),
  KEY audit_events_action_occurred_idx (action, occurred_at),
  KEY audit_events_resource_idx (resource_type, resource_id, occurred_at),
  KEY audit_events_request_idx (request_id),
  CONSTRAINT audit_events_actor_fkey
    FOREIGN KEY (actor_id) REFERENCES user_profiles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
