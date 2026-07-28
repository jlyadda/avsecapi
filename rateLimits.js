const { rateLimit } = require('express-rate-limit');
const config = require('./config');

const baseOptions = { standardHeaders: 'draft-8', legacyHeaders: false };

const apiLimiter = rateLimit({
  ...baseOptions,
  windowMs: config.API_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
  limit: config.API_RATE_LIMIT_MAX,
  message: {
    error: 'Too many requests. Please try again later.',
    code: 'API_RATE_LIMIT_EXCEEDED'
  }
});

const loginLimiter = rateLimit({
  ...baseOptions,
  windowMs: 15 * 60 * 1000,
  limit: 5,
  skipSuccessfulRequests: true,
  message: { error: 'Too many failed login attempts. Please try again later.' }
});

const registerLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * 60 * 1000,
  limit: 3,
  message: { error: 'Too many registration attempts. Please try again later.' }
});

const publicApplicationLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * 60 * 1000,
  limit: 10,
  message: { error: 'Too many visitor applications. Please try again later.' }
});

const passwordResetRequestLimiter = rateLimit({
  ...baseOptions,
  windowMs: 15 * 60 * 1000,
  limit: 3,
  message: { error: 'Too many password reset requests. Please try again later.' }
});

const passwordResetConfirmLimiter = rateLimit({
  ...baseOptions,
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: { error: 'Too many reset attempts. Please try again later.' }
});

module.exports = {
  apiLimiter,
  loginLimiter,
  registerLimiter,
  publicApplicationLimiter,
  passwordResetRequestLimiter,
  passwordResetConfirmLimiter
};
