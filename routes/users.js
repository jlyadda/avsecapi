const express = require('express');
const db = require('../db');
const { authenticateToken, authorizePermission } = require('../middleware');
const { PERMISSIONS, canManageRole } = require('../permissions');
const { validate, schemas } = require('../validation');

const router = express.Router();

const findUser = async (id) => {
  const [rows] = await db.execute(
    'SELECT id, user_role, is_active FROM user_profiles WHERE id = ?',
    [id]
  );
  return rows[0];
};

router.patch(
  '/users/:id/status',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_USERS),
  validate(schemas.userStatus),
  async (req, res) => {
    try {
      const target = await findUser(req.params.id);
      if (!target) return res.status(404).json({ error: 'User not found.' });
      if (target.id === req.user.id && !req.body.is_active) {
        return res.status(400).json({ error: 'You cannot deactivate your own account.' });
      }
      if (!canManageRole(req.user.role, target.user_role)) {
        return res.status(403).json({ error: 'You cannot manage this user.' });
      }

      await db.execute('UPDATE user_profiles SET is_active = ? WHERE id = ?', [req.body.is_active, target.id]);
      if (!req.body.is_active) {
        await db.execute(
          'UPDATE auth_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL',
          [target.id]
        );
      }

      return res.json({ message: req.body.is_active ? 'User activated.' : 'User deactivated.' });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Unable to update user status.' });
    }
  }
);

router.patch(
  '/users/:id/role',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_ROLES),
  validate(schemas.userRole),
  async (req, res) => {
    try {
      const target = await findUser(req.params.id);
      if (!target) return res.status(404).json({ error: 'User not found.' });
      if (target.id === req.user.id) {
        return res.status(400).json({ error: 'You cannot change your own role.' });
      }

      await db.execute('UPDATE user_profiles SET user_role = ? WHERE id = ?', [req.body.role, target.id]);
      await db.execute(
        'UPDATE auth_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL',
        [target.id]
      );

      return res.json({ message: 'User role updated; existing sessions were revoked.' });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Unable to update user role.' });
    }
  }
);

router.post(
  '/users/:id/sessions/revoke',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_USERS),
  validate(schemas.userId),
  async (req, res) => {
    try {
      const target = await findUser(req.params.id);
      if (!target) return res.status(404).json({ error: 'User not found.' });
      if (!canManageRole(req.user.role, target.user_role)) {
        return res.status(403).json({ error: 'You cannot manage this user.' });
      }

      const [result] = await db.execute(
        'UPDATE auth_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL',
        [target.id]
      );
      return res.json({ message: 'User sessions revoked.', revokedSessions: result.affectedRows });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Unable to revoke user sessions.' });
    }
  }
);

module.exports = router;
