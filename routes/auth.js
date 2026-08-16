const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const config = require('../config');
const { authenticateToken, authorizePermission } = require('../middleware');
const { validate, schemas } = require('../validation');
const { loginLimiter } = require('../rateLimits');
const { PERMISSIONS, canManageRole } = require('../permissions');
const { recordAudit, sendError } = require('../audit');
const { createSystemNotification } = require('../services/notificationService');

const router = express.Router();

const issueToken = async (executor, userId, req, parentJti = null) => {
  const jti = uuidv4();
  const expiresAt = new Date(Date.now() + config.JWT_TTL_SECONDS * 1000);
  const token = jwt.sign(
    { id: userId },
    config.JWT_SECRET,
    {
      algorithm: 'HS256',
      audience: 'avsec-clients',
      issuer: 'avsecapi',
      jwtid: jti,
      expiresIn: config.JWT_TTL_SECONDS
    }
  );
  await executor.execute(
    `INSERT INTO auth_tokens
     (jti, user_id, expires_at, ip_address, last_ip_address, user_agent, parent_jti)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      jti,
      userId,
      expiresAt,
      req.ip?.replace(/^::ffff:/, '').slice(0, 45) || null,
      req.ip?.replace(/^::ffff:/, '').slice(0, 45) || null,
      req.get('user-agent')?.slice(0, 500) || null,
      parentJti
    ]
  );
  return { token, jti, expiresAt };
};

router.post(
  '/register',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_USERS),
  validate(schemas.register),
  async (req, res) => {
    const {
      user_name,
      email,
      phone,
      password,
      full_name,
      department,
      role,
      is_active
    } = req.body;
    if (!canManageRole(req.user.role, role)) {
      return sendError(
        res,
        403,
        'USER_ROLE_CREATION_FORBIDDEN',
        'You cannot create a user with this role.'
      );
    }

    const connection = await db.getConnection();
    try {
      const passwordHash = await bcrypt.hash(password, 12);
      const newUserId = uuidv4();
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO user_profiles
         (id, user_name, email, phone, password_hash, full_name, department, user_role,
          is_active, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newUserId,
          user_name,
          email,
          phone || null,
          passwordHash,
          full_name || null,
          department || 'Aviation Security',
          role,
          is_active,
          req.user.id
        ]
      );
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'SYSTEM_USER_CREATED',
        resourceType: 'user',
        resourceId: newUserId,
        requestId: req.requestId,
        metadata: { role, is_active }
      });
      if (is_active) {
        await createSystemNotification(connection, {
          templateCode: 'SYSTEM_USER_CREATED',
          values: {},
          requestId: req.requestId,
          resourceType: 'user',
          resourceId: newUserId,
          targets: [{ type: 'USER', value: newUserId }],
          channels: ['IN_APP', 'EMAIL'],
          metadata: { role }
        });
      }
      await connection.commit();

      return res.status(201).json({
        user: {
          id: newUserId,
          user_name,
          email,
          phone: phone || null,
          full_name: full_name || null,
          department: department || 'Aviation Security',
          role,
          is_active
        }
      });
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') {
        return sendError(res, 409, 'USER_ALREADY_EXISTS', 'Username or email already taken.');
      }
      console.error(error);
      return sendError(res, 500, 'USER_CREATION_FAILED', 'Unable to create system user.');
    } finally {
      connection.release();
    }
  }
);

router.post('/login', loginLimiter, validate(schemas.login), async (req, res) => {
  const { identifier, password } = req.body;

  try {
    const [users] = await db.execute(
      `SELECT id, user_name, email, phone, password_hash, full_name, department, user_role, is_active
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

    const { token, expiresAt } = await issueToken(db, user.id, req);
    await db.execute('UPDATE user_profiles SET last_login = NOW() WHERE id = ?', [user.id]);

    return res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        user_name: user.user_name,
        email: user.email,
        phone: user.phone,
        full_name: user.full_name,
        department: user.department,
        role: user.user_role
      },
      expires_at: expiresAt
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Database error during login.' });
  }
});

router.post('/auth/refresh', authenticateToken, async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.execute(
      `UPDATE auth_tokens
       SET revoked_at = NOW(), revoked_by = ?, revocation_reason = 'REFRESHED'
       WHERE jti = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > NOW()`,
      [req.user.id, req.user.jti, req.user.id]
    );
    if (result.affectedRows !== 1) {
      await connection.rollback();
      return res.status(409).json({ error: 'Session has already been refreshed or revoked.' });
    }
    const { token, expiresAt } = await issueToken(
      connection,
      req.user.id,
      req,
      req.user.jti
    );
    await connection.commit();
    return res.json({ token, expires_at: expiresAt });
  } catch (error) {
    await connection.rollback();
    console.error(error);
    return res.status(500).json({ error: 'Unable to refresh session.' });
  } finally {
    connection.release();
  }
});

router.post('/logout', authenticateToken, async (req, res) => {
  try {
    await db.execute(
      `UPDATE auth_tokens
       SET revoked_at = NOW(), revoked_by = ?, revocation_reason = 'USER_LOGOUT'
       WHERE jti = ? AND revoked_at IS NULL`,
      [req.user.id, req.user.jti]
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
      `UPDATE auth_tokens
       SET revoked_at = NOW(), revoked_by = ?, revocation_reason = 'USER_LOGOUT_ALL'
       WHERE user_id = ? AND revoked_at IS NULL`,
      [req.user.id, req.user.id]
    );
    return res.json({ message: 'All sessions revoked successfully.' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Unable to revoke sessions.' });
  }
});

module.exports = router;
