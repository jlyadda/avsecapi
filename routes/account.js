const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authenticateToken } = require('../middleware');
const { validate, schemas } = require('../validation');

const router = express.Router();

const getAccount = async (userId) => {
  const [rows] = await db.execute(
    `SELECT id, user_name, email, full_name, department, user_role AS role,
            is_active, last_login, created_at, updated_at
     FROM user_profiles
     WHERE id = ?`,
    [userId]
  );
  if (!rows[0]) return null;
  return { ...rows[0], is_active: Boolean(rows[0].is_active) };
};

router.get('/account', authenticateToken, async (req, res) => {
  try {
    const account = await getAccount(req.user.id);
    if (!account) return res.status(404).json({ error: 'Account not found.' });
    return res.json({ account });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Unable to load account.' });
  }
});

router.patch(
  '/account',
  authenticateToken,
  validate(schemas.accountUpdate),
  async (req, res) => {
    try {
      const updates = [];
      const parameters = [];
      for (const field of ['full_name', 'email']) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = ?`);
          parameters.push(req.body[field]);
        }
      }
      parameters.push(req.user.id);
      await db.execute(
        `UPDATE user_profiles SET ${updates.join(', ')} WHERE id = ?`,
        parameters
      );
      const account = await getAccount(req.user.id);
      return res.json({ account });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'Email address is already in use.' });
      }
      console.error(error);
      return res.status(500).json({ error: 'Unable to update account.' });
    }
  }
);

router.post(
  '/account/password',
  authenticateToken,
  validate(schemas.passwordChange),
  async (req, res) => {
    try {
      const [rows] = await db.execute(
        'SELECT password_hash FROM user_profiles WHERE id = ?',
        [req.user.id]
      );
      const account = rows[0];
      if (!account || !(await bcrypt.compare(req.body.current_password, account.password_hash))) {
        return res.status(401).json({ error: 'Current password is incorrect.' });
      }

      const passwordHash = await bcrypt.hash(req.body.new_password, 12);
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute(
          'UPDATE user_profiles SET password_hash = ? WHERE id = ?',
          [passwordHash, req.user.id]
        );
        await connection.execute(
          `UPDATE auth_tokens SET revoked_at = NOW()
           WHERE user_id = ? AND jti <> ? AND revoked_at IS NULL`,
          [req.user.id, req.user.jti]
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }

      return res.json({
        message: 'Password changed. Other active sessions were revoked.'
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Unable to change password.' });
    }
  }
);

module.exports = router;
