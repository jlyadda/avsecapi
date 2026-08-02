ALTER TABLE auth_tokens
  ADD COLUMN last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    AFTER created_at,
  ADD COLUMN ip_address VARCHAR(45) DEFAULT NULL AFTER last_seen_at,
  ADD COLUMN last_ip_address VARCHAR(45) DEFAULT NULL AFTER ip_address,
  ADD COLUMN user_agent VARCHAR(500) DEFAULT NULL AFTER last_ip_address,
  ADD COLUMN parent_jti CHAR(36) DEFAULT NULL AFTER user_agent,
  ADD COLUMN revoked_by CHAR(36) DEFAULT NULL AFTER revoked_at,
  ADD COLUMN revocation_reason VARCHAR(100) DEFAULT NULL AFTER revoked_by,
  ADD KEY auth_tokens_status_activity_idx (revoked_at, expires_at, last_seen_at),
  ADD KEY auth_tokens_revoked_by_idx (revoked_by),
  ADD KEY auth_tokens_parent_idx (parent_jti),
  ADD CONSTRAINT auth_tokens_revoked_by_fkey
    FOREIGN KEY (revoked_by) REFERENCES user_profiles (id) ON DELETE SET NULL;

UPDATE auth_tokens SET last_seen_at = created_at;
