const express = require('express');
const db = require('../db');
const { authenticateToken, authorizePermission } = require('../middleware');
const { PERMISSIONS } = require('../permissions');
const { validate, schemas } = require('../validation');
const { sendError } = require('../audit');

const router = express.Router();

router.get(
  '/audit-events',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_AUDIT_EVENTS),
  validate(schemas.auditEventList),
  async (req, res) => {
    try {
      const {
        actor_id,
        action,
        resource_type,
        resource_id,
        from,
        to,
        page,
        page_size
      } = req.validatedQuery;
      const conditions = [];
      const parameters = [];
      for (const [column, value] of [
        ['e.actor_id', actor_id],
        ['e.action', action],
        ['e.resource_type', resource_type],
        ['e.resource_id', resource_id]
      ]) {
        if (value !== undefined) {
          conditions.push(`${column} = ?`);
          parameters.push(value);
        }
      }
      if (from) {
        conditions.push('e.occurred_at >= ?');
        parameters.push(from);
      }
      if (to) {
        conditions.push('e.occurred_at <= ?');
        parameters.push(to);
      }
      const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const [[countRow]] = await db.execute(
        `SELECT COUNT(*) AS total FROM audit_events e ${whereClause}`,
        parameters
      );
      const total = Number(countRow.total);
      const [events] = await db.execute(
        `SELECT e.id, e.occurred_at, e.actor_id, u.user_name AS actor_user_name,
                e.action, e.resource_type, e.resource_id, e.request_id, e.metadata
         FROM audit_events e
         LEFT JOIN user_profiles u ON u.id = e.actor_id
         ${whereClause}
         ORDER BY e.occurred_at DESC, e.id DESC
         LIMIT ? OFFSET ?`,
        [...parameters, page_size, (page - 1) * page_size]
      );
      return res.json({
        events,
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
        'AUDIT_EVENT_LIST_FAILED',
        'Unable to list audit events.'
      );
    }
  }
);

module.exports = router;
