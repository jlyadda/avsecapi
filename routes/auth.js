const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const config = require('../config');
const { authenticateToken } = require('../middleware');
const { validate, schemas } = require('../validation');
const { loginLimiter, registerLimiter } = require('../rateLimits');

const router = express.Router();

router.post('/register', registerLimiter, validate(schemas.register), async (req, res) => {
  const { user_name, email, password, full_name, department } = req.body;

  try {
    const [existingUsers] = await db.execute(
      'SELECT id FROM user_profiles WHERE email = ? OR user_name = ?',
      [email, user_name]
    );

    if (existingUsers.length > 0) {
      return res.status(409).json({ error: 'Username or email already taken.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const newUserId = uuidv4();

    await db.execute(
      `INSERT INTO user_profiles
       (id, user_name, email, password_hash, full_name, department, user_role, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 'security_assistant', 0)`,
      [newUserId, user_name, email, passwordHash, full_name || null, department || 'Aviation Security']
    );

    return res.status(202).json({
      message: 'Registration submitted for administrator approval.',
      userId: newUserId
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Database error during registration.' });
  }
});

router.post('/login', loginLimiter, validate(schemas.login), async (req, res) => {
  const { identifier, password } = req.body;

  try {
    const [users] = await db.execute(
      `SELECT id, user_name, email, password_hash, department, user_role, is_active
       FROM user_profiles WHERE email = ? OR user_name = ?`,
      [identifier.toLowerCase(), identifier]
    );

    const user = users[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid username/email or password.' });
    }
    if (!user.is_active) {
      return res.status(403).json({ error: 'This account is awaiting approval or has been deactivated.' });
    }

    const jti = uuidv4();
    const expiresAt = new Date(Date.now() + config.JWT_TTL_SECONDS * 1000);
    const token = jwt.sign(
      { id: user.id },
      config.JWT_SECRET,
      {
        algorithm: 'HS256',
        audience: 'avsec-clients',
        issuer: 'avsecapi',
        jwtid: jti,
        expiresIn: config.JWT_TTL_SECONDS
      }
    );

    await db.execute(
      'INSERT INTO auth_tokens (jti, user_id, expires_at) VALUES (?, ?, ?)',
      [jti, user.id, expiresAt]
    );
    await db.execute('UPDATE user_profiles SET last_login = NOW() WHERE id = ?', [user.id]);

    return res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        user_name: user.user_name,
        email: user.email,
        role: user.user_role
      }
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Database error during login.' });
  }
});

router.post('/logout', authenticateToken, async (req, res) => {
  try {
    await db.execute(
      'UPDATE auth_tokens SET revoked_at = NOW() WHERE jti = ? AND revoked_at IS NULL',
      [req.user.jti]
    );
    return res.json({ message: 'Logout successful.' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Unable to revoke token.' });
  }
});

router.post('/logout-all', authenticateToken, async (req, res) => {
  try {
    await db.execute(
      'UPDATE auth_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL',
      [req.user.id]
    );
    return res.json({ message: 'All sessions revoked successfully.' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Unable to revoke sessions.' });
  }
});

module.exports = router;
