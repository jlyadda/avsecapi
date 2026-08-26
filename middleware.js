const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const db = require('./db');
const config = require('./config');
const { hasPermission } = require('./permissions');
const { csrfTokensMatch } = require('./services/authCookieService');
const { hashSecret } = require('./services/browserContextService');

const hashApiKey = (value) => crypto.createHash('sha256').update(value).digest();
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const allowedOrigins = new Set(config.CORS_ALLOWED_ORIGINS);

const hasTrustedOrigin = (req) => {
  const origin = req.get('origin');
  return !origin || allowedOrigins.has(origin.replace(/\/$/, ''));
};

const enforceTrustedBrowserOrigin = (req, res, next) => {
  if (config.AUTH_COOKIE_ENABLED && !hasTrustedOrigin(req)) {
    return res.status(403).json({
      error: 'Request origin is not permitted.',
      code: 'ORIGIN_NOT_ALLOWED'
    });
  }
  return next();
};

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
  const [scheme, bearerToken] = authHeader?.split(' ') || [];
  const tabHandle = req.get('x-avsec-session');
  const browserSecret = req.cookies?.[config.BROWSER_CONTEXT_COOKIE_NAME];
  const legacyCookieToken = config.AUTH_LEGACY_COOKIE_ENABLED
    ? req.cookies?.[config.AUTH_COOKIE_NAME]
    : null;
  const token = scheme === 'Bearer' && bearerToken ? bearerToken : legacyCookieToken;
  const authTransport = scheme === 'Bearer' && bearerToken
    ? 'bearer'
    : tabHandle || browserSecret
      ? 'tab'
      : 'cookie';

  if (authTransport === 'tab' && (!tabHandle || !browserSecret)) {
    return res.status(401).json({
      error: 'The browser cookie and tab session handle are both required.',
      code: 'AUTH_TAB_SESSION_REQUIRED'
    });
  }

  if (authTransport !== 'tab' && !token) {
    return res.status(401).json({
      error: 'Access denied. Not Authenticated.',
      code: 'AUTH_TOKEN_REQUIRED'
    });
  }

  try {
    let rows;
    if (authTransport === 'tab') {
      if (!/^[A-Za-z0-9_-]{43}$/.test(tabHandle)
        || !/^[A-Za-z0-9_-]{43}$/.test(browserSecret)) {
        return res.status(403).json({
          error: 'The tab session is invalid.',
          code: 'AUTH_SESSION_INVALID'
        });
      }
      [rows] = await db.execute(
        `SELECT u.id, u.user_role, u.department, u.is_active,
                s.jti, s.revoked_at, s.expires_at, s.csrf_token_hash,
                s.browser_context_id
         FROM auth_tokens s
         INNER JOIN user_profiles u ON u.id = s.user_id
         INNER JOIN browser_contexts browser ON browser.id = s.browser_context_id
         WHERE s.session_handle_hash = ? AND browser.secret_hash = ?
           AND browser.revoked_at IS NULL AND browser.expires_at > NOW(3)`,
        [hashSecret(tabHandle), hashSecret(browserSecret)]
      );
    } else {
      const decoded = jwt.verify(token, config.JWT_SECRET, {
        algorithms: ['HS256'],
        issuer: 'avsecapi',
        audience: 'avsec-clients'
      });

      if (!decoded.id || !decoded.jti) {
        return res.status(403).json({
          error: 'Access denied. Not Authenticated.',
          code: 'AUTH_TOKEN_INVALID'
        });
      }

      [rows] = await db.execute(
        `SELECT u.id, u.user_role, u.department, u.is_active,
                s.jti, s.revoked_at, s.expires_at, s.csrf_token_hash,
                s.browser_context_id
         FROM auth_tokens s
         INNER JOIN user_profiles u ON u.id = s.user_id
         WHERE s.jti = ? AND s.user_id = ?`,
        [decoded.jti, decoded.id]
      );
    }

    const session = rows[0];
    if (!session || !session.is_active || session.revoked_at || new Date(session.expires_at) <= new Date()) {
      return res.status(403).json({
        error: 'Access denied. Not Authenticated.',
        code: 'AUTH_SESSION_INVALID'
      });
    }

    req.user = {
      id: session.id,
      role: session.user_role,
      dept: session.department,
      jti: session.jti
    };
    req.authTransport = authTransport;
    req.browserContextId = session.browser_context_id || null;

    if (authTransport !== 'bearer' && !safeMethods.has(req.method)) {
      const csrfToken = req.get('x-csrf-token');
      if (!hasTrustedOrigin(req) || !csrfTokensMatch(csrfToken, session.csrf_token_hash)) {
        return res.status(403).json({
          error: 'A valid CSRF token is required for this request.',
          code: 'CSRF_TOKEN_INVALID'
        });
      }
    }
    await db.execute(
      `UPDATE auth_tokens
       SET last_seen_at = NOW(3), last_ip_address = ?
       WHERE jti = ?
         AND last_seen_at < DATE_SUB(NOW(3), INTERVAL 60 SECOND)`,
      [req.ip?.replace(/^::ffff:/, '').slice(0, 45) || null, session.jti]
    );
    if (session.browser_context_id) {
      await db.execute(
        `UPDATE browser_contexts
         SET last_seen_at = NOW(3), last_ip_address = ?
         WHERE id = ? AND last_seen_at < DATE_SUB(NOW(3), INTERVAL 60 SECOND)`,
        [
          req.ip?.replace(/^::ffff:/, '').slice(0, 45) || null,
          session.browser_context_id
        ]
      );
    }
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
      error: 'Access denied. Not Authenticated.',
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

module.exports = {
  authenticateToken,
  authenticateApiKey,
  authorizePermission,
  enforceTrustedBrowserOrigin
};
