ALTER TABLE auth_tokens
  ADD COLUMN csrf_token_hash CHAR(64) DEFAULT NULL AFTER parent_jti;
