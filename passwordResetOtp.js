const crypto = require('node:crypto');
const config = require('./config');

const generateOtp = () => String(crypto.randomInt(10000, 100000));

const hashOtp = (userId, otp) => crypto
  .createHmac('sha256', config.JWT_SECRET)
  .update(`${userId}:${otp}`)
  .digest('hex');

const otpMatches = (userId, otp, expectedHash) => {
  const actual = Buffer.from(hashOtp(userId, otp), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};

module.exports = { generateOtp, hashOtp, otpMatches };
