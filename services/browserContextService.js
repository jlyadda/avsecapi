const crypto = require('node:crypto');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');

const createSecret = () => crypto.randomBytes(32).toString('base64url');

const hashSecret = (secret) => crypto
  .createHash('sha256')
  .update(secret)
  .digest('hex');

const getClientIp = (req) => req.ip?.replace(/^::ffff:/, '').slice(0, 45) || null;

const getOrCreateBrowserContext = async (executor, req) => {
  const suppliedSecret = req.cookies?.[config.BROWSER_CONTEXT_COOKIE_NAME];
  const expiresAt = new Date(Date.now() + config.BROWSER_CONTEXT_TTL_SECONDS * 1000);

  if (suppliedSecret && /^[A-Za-z0-9_-]{43}$/.test(suppliedSecret)) {
    const [rows] = await executor.execute(
      `SELECT id
       FROM browser_contexts
       WHERE secret_hash = ? AND revoked_at IS NULL AND expires_at > NOW(3)`,
      [hashSecret(suppliedSecret)]
    );
    if (rows[0]) {
      await executor.execute(
        `UPDATE browser_contexts
         SET expires_at = ?, last_seen_at = NOW(3), last_ip_address = ?
         WHERE id = ?`,
        [expiresAt, getClientIp(req), rows[0].id]
      );
      return { id: rows[0].id, secret: suppliedSecret, expiresAt };
    }
  }

  const id = uuidv4();
  const secret = createSecret();
  await executor.execute(
    `INSERT INTO browser_contexts
     (id, secret_hash, expires_at, initial_ip_address, last_ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      hashSecret(secret),
      expiresAt,
      getClientIp(req),
      getClientIp(req),
      req.get('user-agent')?.slice(0, 500) || null
    ]
  );
  return { id, secret, expiresAt };
};

module.exports = { createSecret, getOrCreateBrowserContext, hashSecret };
