CREATE TABLE password_reset_otps (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  otp_hash CHAR(64) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  attempt_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
  consumed_at DATETIME(3) DEFAULT NULL,
  requested_ip VARCHAR(45) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY password_reset_otps_user_created_idx (user_id, created_at),
  KEY password_reset_otps_expires_idx (expires_at),
  CONSTRAINT password_reset_otps_user_fkey
    FOREIGN KEY (user_id) REFERENCES user_profiles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
