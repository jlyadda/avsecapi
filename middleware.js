const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const db = require('./db');
const config = require('./config');
const { hasPermission } = require('./permissions');

const hashApiKey = (value) => crypto.createHash('sha256').update(value).digest();

const authenticateApiKey = (...allowedRoles) => async (req, res, next) => {
  const providedKey = req.get('x-api-key');
  if (!providedKey) {
    return res.status(401).json({ error: 'A valid API key is required.' });
  }

  const providedHash = hashApiKey(providedKey);
  const staticKeyMatched = config.PUBLIC_APP_API_KEYS.some((key) => (
    crypto.timingSafeEqual(providedHash, hashApiKey(key))
  ));

  if (staticKeyMatched) {
    const role = 'VISITOR_APPLICATION';
    if (allowedRoles.length > 0 && !allowedRoles.includes(role)) {
      return res.status(403).json({ error: 'API key does not have the required role.' });
    }
    req.apiClient = {
      role,
      keyFingerprint: providedHash.toString('hex').slice(0, 16),
      source: 'environment'
    };
    return next();
  }

  try {
    const [rows] = await db.execute(
      `SELECT id, api_role, key_prefix
       FROM external_api_keys
       WHERE key_hash = ? AND is_active = 1
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [providedHash.toString('hex')]
    );
    const apiKey = rows[0];

    if (!apiKey) {
      return res.status(401).json({ error: 'A valid API key is required.' });
    }
    if (allowedRoles.length > 0 && !allowedRoles.includes(apiKey.api_role)) {
      return res.status(403).json({ error: 'API key does not have the required role.' });
    }

    await db.execute('UPDATE external_api_keys SET last_used_at = NOW() WHERE id = ?', [apiKey.id]);
    req.apiClient = {
      id: apiKey.id,
      role: apiKey.api_role,
      keyFingerprint: apiKey.key_prefix,
      source: 'database'
    };
    return next();
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Unable to verify API key.' });
  }
};

const authenticateToken = async (req, res, next) => {
  const authHeader = req.get('authorization');
  const [scheme, token] = authHeader?.split(' ') || [];

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({
      error: 'Access denied. No token provided.',
      code: 'AUTH_TOKEN_REQUIRED'
    });
  }

  try {
    const decoded = jwt.verify(token, config.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'avsecapi',
      audience: 'avsec-clients'
    });

    if (!decoded.id || !decoded.jti) {
      return res.status(403).json({
        error: 'Invalid or expired token.',
        code: 'AUTH_TOKEN_INVALID'
      });
    }

    const [rows] = await db.execute(
      `SELECT u.id, u.user_role, u.department, u.is_active, s.revoked_at, s.expires_at
       FROM auth_tokens s
       INNER JOIN user_profiles u ON u.id = s.user_id
       WHERE s.jti = ? AND s.user_id = ?`,
      [decoded.jti, decoded.id]
    );

    const session = rows[0];
    if (!session || !session.is_active || session.revoked_at || new Date(session.expires_at) <= new Date()) {
      return res.status(403).json({
        error: 'Token has been revoked or the account is inactive.',
        code: 'AUTH_SESSION_INVALID'
      });
    }

    req.user = {
      id: session.id,
      role: session.user_role,
      dept: session.department,
      jti: decoded.jti
    };
    return next();
  } catch (error) {
    if (!['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error.name)) {
      console.error(error);
      return res.status(500).json({
        error: 'Unable to verify authentication.',
        code: 'AUTH_VERIFICATION_FAILED'
      });
    }
    return res.status(403).json({
      error: 'Invalid or expired token.',
      code: 'AUTH_TOKEN_INVALID'
    });
  }
};

const authorizePermission = (permission) => (req, res, next) => {
  if (!req.user || !hasPermission(req.user.role, permission)) {
    return res.status(403).json({
      error: 'Access denied. Missing permission.',
      code: 'PERMISSION_DENIED'
    });
  }
  return next();
};

module.exports = { authenticateToken, authenticateApiKey, authorizePermission };
