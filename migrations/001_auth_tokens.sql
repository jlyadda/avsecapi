CREATE TABLE IF NOT EXISTS auth_tokens (
  jti CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (jti),
  KEY auth_tokens_user_id_idx (user_id),
  KEY auth_tokens_expires_at_idx (expires_at),
  CONSTRAINT auth_tokens_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES user_profiles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
