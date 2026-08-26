CREATE TABLE browser_contexts (
  id CHAR(36) NOT NULL,
  secret_hash CHAR(64) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  initial_ip_address VARCHAR(45) DEFAULT NULL,
  last_ip_address VARCHAR(45) DEFAULT NULL,
  user_agent VARCHAR(500) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY browser_contexts_secret_key (secret_hash),
  KEY browser_contexts_status_idx (revoked_at, expires_at, last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE auth_tokens
  ADD COLUMN browser_context_id CHAR(36) DEFAULT NULL AFTER csrf_token_hash,
  ADD COLUMN session_handle_hash CHAR(64) DEFAULT NULL AFTER browser_context_id,
  ADD UNIQUE KEY auth_tokens_session_handle_key (session_handle_hash),
  ADD KEY auth_tokens_browser_context_idx (browser_context_id, revoked_at, expires_at),
  ADD CONSTRAINT auth_tokens_browser_context_fkey
    FOREIGN KEY (browser_context_id) REFERENCES browser_contexts (id) ON DELETE SET NULL;
