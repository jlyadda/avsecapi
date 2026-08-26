const crypto = require('node:crypto');
const config = require('../config');

const createCsrfToken = () => crypto.randomBytes(32).toString('base64url');

const hashCsrfToken = (token) => crypto
  .createHash('sha256')
  .update(token)
  .digest('hex');

const cookieOptions = (expiresAt, path = config.AUTH_COOKIE_PATH) => {
  const options = {
    httpOnly: true,
    secure: config.AUTH_COOKIE_SECURE,
    sameSite: config.AUTH_COOKIE_SAME_SITE,
    path,
    expires: expiresAt
  };
  if (config.AUTH_COOKIE_DOMAIN) options.domain = config.AUTH_COOKIE_DOMAIN;
  return options;
};

const setAuthCookie = (res, token, expiresAt) => {
  if (!config.AUTH_COOKIE_ENABLED || !config.AUTH_LEGACY_COOKIE_ENABLED) return;
  res.cookie(config.AUTH_COOKIE_NAME, token, cookieOptions(expiresAt));
  if (config.AUTH_COOKIE_PATH !== '/api') {
    const legacyOptions = cookieOptions(undefined, '/api');
    delete legacyOptions.expires;
    res.clearCookie(config.AUTH_COOKIE_NAME, legacyOptions);
  }
};

const clearAuthCookie = (res) => {
  const options = cookieOptions(new Date(0));
  delete options.expires;
  res.clearCookie(config.AUTH_COOKIE_NAME, options);
  if (config.AUTH_COOKIE_PATH !== '/api') {
    res.clearCookie(config.AUTH_COOKIE_NAME, { ...options, path: '/api' });
  }
};

const setBrowserContextCookie = (res, secret, expiresAt) => {
  if (!config.AUTH_COOKIE_ENABLED) return;
  res.cookie(
    config.BROWSER_CONTEXT_COOKIE_NAME,
    secret,
    cookieOptions(expiresAt)
  );
};

const clearBrowserContextCookie = (res) => {
  const options = cookieOptions(new Date(0));
  delete options.expires;
  res.clearCookie(config.BROWSER_CONTEXT_COOKIE_NAME, options);
};

const csrfTokensMatch = (providedToken, storedHash) => {
  if (!providedToken || !/^[a-f0-9]{64}$/i.test(storedHash)) return false;
  const providedHash = hashCsrfToken(providedToken);
  return crypto.timingSafeEqual(Buffer.from(providedHash), Buffer.from(storedHash));
};

module.exports = {
  clearAuthCookie,
  clearBrowserContextCookie,
  createCsrfToken,
  csrfTokensMatch,
  hashCsrfToken,
  setAuthCookie,
  setBrowserContextCookie
};
