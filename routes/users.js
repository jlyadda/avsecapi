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

router.get(
  '/users',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_USERS),
  validate(schemas.userList),
  async (req, res) => {
    try {
      const { search, role, is_active, page, page_size } = req.validatedQuery;
      const conditions = [];
      const parameters = [];

      if (search) {
        const searchValue = `%${search}%`;
        conditions.push(
          '(user_name LIKE ? OR email LIKE ? OR phone LIKE ? OR full_name LIKE ? OR department LIKE ?)'
        );
        parameters.push(...Array(5).fill(searchValue));
      }
      if (role) {
        conditions.push('user_role = ?');
        parameters.push(role);
      }
      if (is_active !== undefined) {
        conditions.push('is_active = ?');
        parameters.push(is_active);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const [countRows] = await db.execute(
        `SELECT COUNT(*) AS total FROM user_profiles ${whereClause}`,
        parameters
      );
      const total = Number(countRows[0].total);
      const offset = (page - 1) * page_size;
      const [users] = await db.execute(
        `SELECT id, user_name, email, phone, full_name, department, user_role AS role, is_active,
                last_login, created_at
         FROM user_profiles
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
        [...parameters, page_size, offset]
      );

      return res.json({
        users: users.map((user) => ({ ...user, is_active: Boolean(user.is_active) })),
        pagination: {
          page,
          page_size,
          total,
          total_pages: Math.ceil(total / page_size)
        }
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Unable to list staff users.' });
    }
  }
);

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
          `UPDATE auth_tokens
           SET revoked_at = NOW(), revoked_by = ?, revocation_reason = 'ACCOUNT_DEACTIVATED'
           WHERE user_id = ? AND revoked_at IS NULL`,
          [req.user.id, target.id]
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
        `UPDATE auth_tokens
         SET revoked_at = NOW(), revoked_by = ?, revocation_reason = 'ROLE_CHANGED'
         WHERE user_id = ? AND revoked_at IS NULL`,
        [req.user.id, target.id]
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
        `UPDATE auth_tokens
         SET revoked_at = NOW(), revoked_by = ?, revocation_reason = 'ADMIN_REVOKED_ALL'
         WHERE user_id = ? AND revoked_at IS NULL`,
        [req.user.id, target.id]
      );
      return res.json({ message: 'User sessions revoked.', revokedSessions: result.affectedRows });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Unable to revoke user sessions.' });
    }
  }
);

module.exports = router;
