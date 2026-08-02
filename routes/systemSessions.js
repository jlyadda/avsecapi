const express = require('express');
const db = require('../db');
const { authenticateToken, authorizePermission } = require('../middleware');
const { PERMISSIONS } = require('../permissions');
const { validate, schemas } = require('../validation');
const { recordAudit, sendError } = require('../audit');

const router = express.Router();

const statusExpression = `CASE
  WHEN token.revoked_at IS NOT NULL THEN 'REVOKED'
  WHEN token.expires_at <= NOW(3) THEN 'EXPIRED'
  WHEN user.is_active = 0 THEN 'ACCOUNT_INACTIVE'
  ELSE 'ACTIVE'
END`;

router.get(
  '/admin/system-sessions',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_SYSTEM_SESSIONS),
  validate(schemas.systemSessionList),
  async (req, res) => {
    try {
      const { search, status, role, user_id, ip_address, page, page_size } =
        req.validatedQuery;
      const conditions = [];
      const values = [];
      if (status === 'ACTIVE') {
        conditions.push(
          'token.revoked_at IS NULL AND token.expires_at > NOW(3) AND user.is_active = 1'
        );
      } else if (status === 'REVOKED') {
        conditions.push('token.revoked_at IS NOT NULL');
      } else if (status === 'EXPIRED') {
        conditions.push('token.revoked_at IS NULL AND token.expires_at <= NOW(3)');
      }
      if (search) {
        const value = `%${search}%`;
        conditions.push(`(
          user.user_name LIKE ? OR user.email LIKE ? OR user.full_name LIKE ?
          OR user.department LIKE ? OR token.ip_address LIKE ?
          OR token.last_ip_address LIKE ?
        )`);
        values.push(...Array(6).fill(value));
      }
      if (role) {
        conditions.push('user.user_role = ?');
        values.push(role);
      }
      if (user_id) {
        conditions.push('user.id = ?');
        values.push(user_id);
      }
      if (ip_address) {
        conditions.push('(token.ip_address = ? OR token.last_ip_address = ?)');
        values.push(ip_address, ip_address);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const [[count]] = await db.execute(
        `SELECT COUNT(*) AS total
         FROM auth_tokens token
         INNER JOIN user_profiles user ON user.id = token.user_id
         ${where}`,
        values
      );
      const total = Number(count.total);
      const [sessions] = await db.execute(
        `SELECT token.jti AS session_id, token.user_id,
                user.user_name, user.email, user.full_name, user.department,
                user.user_role AS role, user.is_active AS account_active,
                ${statusExpression} AS status,
                token.created_at AS session_started_at,
                token.last_seen_at, token.expires_at,
                token.revoked_at, token.revocation_reason,
                token.revoked_by AS revoked_by_id,
                COALESCE(revoker.full_name, revoker.user_name) AS revoked_by,
                token.ip_address, token.last_ip_address, token.user_agent,
                token.parent_jti,
                TIMESTAMPDIFF(SECOND, token.created_at, token.expires_at)
                  AS configured_duration_seconds,
                TIMESTAMPDIFF(
                  SECOND,
                  token.created_at,
                  LEAST(COALESCE(token.revoked_at, NOW(3)), token.expires_at)
                ) AS elapsed_duration_seconds,
                GREATEST(TIMESTAMPDIFF(SECOND, NOW(3), token.expires_at), 0)
                  AS remaining_seconds,
                token.jti = ? AS is_current_session
         FROM auth_tokens token
         INNER JOIN user_profiles user ON user.id = token.user_id
         LEFT JOIN user_profiles revoker ON revoker.id = token.revoked_by
         ${where}
         ORDER BY token.last_seen_at DESC, token.created_at DESC
         LIMIT ? OFFSET ?`,
        [req.user.jti, ...values, page_size, (page - 1) * page_size]
      );
      const [[summary]] = await db.query(
        `SELECT
           COUNT(DISTINCT CASE
             WHEN token.revoked_at IS NULL AND token.expires_at > NOW(3)
                  AND user.is_active = 1 THEN token.user_id END) AS logged_in_users,
           SUM(token.revoked_at IS NULL AND token.expires_at > NOW(3)
               AND user.is_active = 1) AS active_sessions,
           SUM(token.revoked_at IS NOT NULL) AS revoked_sessions,
           SUM(token.revoked_at IS NULL AND token.expires_at <= NOW(3)) AS expired_sessions
         FROM auth_tokens token
         INNER JOIN user_profiles user ON user.id = token.user_id`
      );
      await recordAudit(db, {
        actorId: req.user.id,
        action: 'SYSTEM_SESSIONS_VIEWED',
        resourceType: 'system_session',
        resourceId: req.user.id,
        requestId: req.requestId,
        metadata: { status, role: role || null, page, page_size }
      });
      return res.json({
        summary: {
          logged_in_users: Number(summary.logged_in_users),
          active_sessions: Number(summary.active_sessions),
          revoked_sessions: Number(summary.revoked_sessions),
          expired_sessions: Number(summary.expired_sessions)
        },
        sessions: sessions.map((session) => ({
          ...session,
          account_active: Boolean(session.account_active),
          is_current_session: Boolean(session.is_current_session)
        })),
        pagination: {
          page,
          page_size,
          total,
          total_pages: Math.ceil(total / page_size)
        }
      });
    } catch (error) {
      console.error(error);
      return sendError(
        res,
        500,
        'SYSTEM_SESSION_LIST_FAILED',
        'Unable to list system sessions.'
      );
    }
  }
);

router.post(
  '/admin/system-sessions/:jti/revoke',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_SYSTEM_SESSIONS),
  validate(schemas.systemSessionRevoke),
  async (req, res) => {
    if (req.params.jti === req.user.jti) {
      return sendError(
        res,
        400,
        'CURRENT_SESSION_REVOCATION_FORBIDDEN',
        'Use the logout endpoint to revoke your current session.'
      );
    }
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [sessions] = await connection.execute(
        `SELECT token.jti, token.user_id, token.revoked_at, token.expires_at,
                user.user_name
         FROM auth_tokens token
         INNER JOIN user_profiles user ON user.id = token.user_id
         WHERE token.jti = ? FOR UPDATE`,
        [req.params.jti]
      );
      const session = sessions[0];
      if (!session) {
        await connection.rollback();
        return sendError(res, 404, 'SYSTEM_SESSION_NOT_FOUND', 'System session not found.');
      }
      if (session.revoked_at || new Date(session.expires_at) <= new Date()) {
        await connection.rollback();
        return sendError(
          res,
          409,
          'SYSTEM_SESSION_NOT_ACTIVE',
          'Only an active session can be revoked.'
        );
      }
      await connection.execute(
        `UPDATE auth_tokens
         SET revoked_at = NOW(3), revoked_by = ?,
             revocation_reason = 'SUPER_ADMIN_REVOKED'
         WHERE jti = ?`,
        [req.user.id, session.jti]
      );
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'SYSTEM_SESSION_REVOKED',
        resourceType: 'system_session',
        resourceId: session.jti,
        requestId: req.requestId,
        metadata: {
          user_id: session.user_id,
          user_name: session.user_name,
          reason: req.body.reason || null
        }
      });
      await connection.commit();
      return res.json({
        message: 'System session revoked.',
        session_id: session.jti,
        user_id: session.user_id
      });
    } catch (error) {
      await connection.rollback();
      console.error(error);
      return sendError(
        res,
        500,
        'SYSTEM_SESSION_REVOKE_FAILED',
        'Unable to revoke system session.'
      );
    } finally {
      connection.release();
    }
  }
);

module.exports = router;
