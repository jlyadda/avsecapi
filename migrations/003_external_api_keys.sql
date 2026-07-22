CREATE TABLE external_api_keys (
  id CHAR(36) NOT NULL,
  name VARCHAR(100) NOT NULL,
  purpose VARCHAR(500) NOT NULL,
  api_role ENUM('VISITOR_APPLICATION') NOT NULL,
  key_hash CHAR(64) NOT NULL,
  key_prefix VARCHAR(16) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  expires_at DATETIME DEFAULT NULL,
  last_used_at DATETIME DEFAULT NULL,
  revoked_at DATETIME DEFAULT NULL,
  created_by CHAR(36) NOT NULL,
  revoked_by CHAR(36) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (id),
  UNIQUE KEY external_api_keys_hash_key (key_hash),
  KEY external_api_keys_active_expiry_idx (is_active, expires_at),
  KEY external_api_keys_created_by_idx (created_by),
  KEY external_api_keys_revoked_by_idx (revoked_by),
  CONSTRAINT external_api_keys_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES user_profiles (id),
  CONSTRAINT external_api_keys_revoked_by_fkey
    FOREIGN KEY (revoked_by) REFERENCES user_profiles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
