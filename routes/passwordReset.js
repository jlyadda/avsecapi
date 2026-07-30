const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const config = require('../config');
const { validate, schemas } = require('../validation');
const {
  passwordResetRequestLimiter,
  passwordResetConfirmLimiter
} = require('../rateLimits');
const {
  isEmailConfigured,
  sendPasswordResetOtp
} = require('../services/emailService');
const { generateOtp, hashOtp, otpMatches } = require('../passwordResetOtp');

const router = express.Router();
const requestAcceptedMessage = 'If an active account matches that email, a reset code will be sent.';

router.post(
  '/password-reset/request',
  passwordResetRequestLimiter,
  validate(schemas.passwordResetRequest),
  async (req, res) => {
    if (!isEmailConfigured) {
      return res.status(503).json({ error: 'Password reset email delivery is not configured.' });
    }

    const connection = await db.getConnection();
    let delivery;
    try {
      await connection.beginTransaction();
      const [users] = await connection.execute(
        `SELECT id, email, full_name
         FROM user_profiles
         WHERE email = ? AND is_active = 1
         LIMIT 1`,
        [req.body.email]
      );
      const user = users[0];
      if (!user) {
        await connection.commit();
        return res.status(202).json({ message: requestAcceptedMessage });
      }

      const [recentRows] = await connection.execute(
        `SELECT id
         FROM password_reset_otps
         WHERE user_id = ? AND consumed_at IS NULL
           AND expires_at > NOW()
           AND created_at > DATE_SUB(NOW(), INTERVAL 2 MINUTE)
         LIMIT 1`,
        [user.id]
      );
      if (recentRows.length > 0) {
        await connection.commit();
        return res.status(202).json({ message: requestAcceptedMessage });
      }

      await connection.execute(
        `UPDATE password_reset_otps
         SET consumed_at = NOW()
         WHERE user_id = ? AND consumed_at IS NULL`,
        [user.id]
      );
      const otp = generateOtp();
      const resetId = uuidv4();
      const expiresAt = new Date(
        Date.now() + config.PASSWORD_RESET_OTP_TTL_MINUTES * 60 * 1000
      );
      await connection.execute(
        `INSERT INTO password_reset_otps
         (id, user_id, otp_hash, expires_at, requested_ip)
         VALUES (?, ?, ?, ?, ?)`,
        [resetId, user.id, hashOtp(user.id, otp), expiresAt, req.ip || null]
      );
      await connection.commit();
      delivery = { resetId, email: user.email, fullName: user.full_name, otp };
    } catch (error) {
      await connection.rollback();
      console.error(error);
      return res.status(500).json({ error: 'Unable to process password reset request.' });
    } finally {
      connection.release();
    }

    try {
      await sendPasswordResetOtp(delivery);
    } catch (error) {
      await db.execute(
        'UPDATE password_reset_otps SET consumed_at = NOW() WHERE id = ?',
        [delivery.resetId]
      );
      console.error('Password reset email delivery failed:', error.message);
    }
    return res.status(202).json({ message: requestAcceptedMessage });
  }
);

router.post(
  '/password-reset/confirm',
  passwordResetConfirmLimiter,
  validate(schemas.passwordResetConfirm),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT o.id, o.user_id, o.otp_hash, o.expires_at, o.attempt_count
         FROM password_reset_otps o
         INNER JOIN user_profiles u ON u.id = o.user_id
         WHERE u.email = ? AND u.is_active = 1 AND o.consumed_at IS NULL
         ORDER BY o.created_at DESC
         LIMIT 1 FOR UPDATE`,
        [req.body.email]
      );
      const reset = rows[0];
      if (!reset || new Date(reset.expires_at) <= new Date()) {
        if (reset) {
          await connection.execute(
            'UPDATE password_reset_otps SET consumed_at = NOW() WHERE id = ?',
            [reset.id]
          );
        }
        await connection.commit();
        return res.status(400).json({ error: 'Reset code is invalid or expired.' });
      }

      if (!otpMatches(reset.user_id, req.body.otp, reset.otp_hash)) {
        const attempts = reset.attempt_count + 1;
        await connection.execute(
          `UPDATE password_reset_otps
           SET attempt_count = ?, consumed_at = CASE WHEN ? >= 5 THEN NOW() ELSE NULL END
           WHERE id = ?`,
          [attempts, attempts, reset.id]
        );
        await connection.commit();
        return res.status(400).json({ error: 'Reset code is invalid or expired.' });
      }

      const passwordHash = await bcrypt.hash(req.body.new_password, 12);
      await connection.execute(
        'UPDATE user_profiles SET password_hash = ? WHERE id = ?',
        [passwordHash, reset.user_id]
      );
      await connection.execute(
        `UPDATE password_reset_otps
         SET consumed_at = NOW()
         WHERE user_id = ? AND consumed_at IS NULL`,
        [reset.user_id]
      );
      await connection.execute(
        `UPDATE auth_tokens
         SET revoked_at = NOW()
         WHERE user_id = ? AND revoked_at IS NULL`,
        [reset.user_id]
      );
      await connection.commit();
      return res.json({
        message: 'Password reset successful. Sign in with the new password.'
      });
    } catch (error) {
      await connection.rollback();
      console.error(error);
      return res.status(500).json({ error: 'Unable to reset password.' });
    } finally {
      connection.release();
    }
  }
);

module.exports = router;
