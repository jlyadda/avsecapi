const express = require('express');
const db = require('../db');
const { authenticateToken, authorizePermission } = require('../middleware');
const { PERMISSIONS } = require('../permissions');
const { validate, schemas } = require('../validation');
const { recordAudit, sendError } = require('../audit');

const router = express.Router();

const allVisitorSelect = `
  SELECT visitor.id, visitor.first_name, visitor.last_name, visitor.other_names,
         visitor.identity_type,
         CONCAT('****', RIGHT(visitor.identity_number, 4)) AS identity_number_masked,
         visitor.issuing_country, visitor.identity_expiry_date,
         visitor.company, visitor.company_position, visitor.security_status,
         visitor.last_visit, visitor.created_at,
         COUNT(DISTINCT application.id) AS application_count,
         MAX(application.created_at) AS last_application_at,
         MAX(active.status) AS active_visit_status
  FROM all_visitors visitor
  LEFT JOIN visitor_applications application ON application.visitor_id = visitor.id
  LEFT JOIN visitors active ON active.all_visitor_id = visitor.id`;

const normalize = (visitor) => ({
  ...visitor,
  application_count: Number(visitor.application_count)
});

router.get(
  '/all-visitors',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_ALL_VISITORS),
  validate(schemas.allVisitorList),
  async (req, res) => {
    try {
      const { search, security_status, page, page_size } = req.validatedQuery;
      const conditions = [];
      const parameters = [];
      if (search) {
        const value = `%${search}%`;
        conditions.push(`(
          visitor.first_name LIKE ? OR visitor.last_name LIKE ?
          OR visitor.other_names LIKE ? OR visitor.identity_number LIKE ?
          OR visitor.company LIKE ?
        )`);
        parameters.push(value, value, value, value, value);
      }
      if (security_status) {
        conditions.push('visitor.security_status = ?');
        parameters.push(security_status);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const [[count]] = await db.execute(
        `SELECT COUNT(*) AS total FROM all_visitors visitor ${where}`,
        parameters
      );
      const total = Number(count.total);
      const [visitors] = await db.execute(
        `${allVisitorSelect}
         ${where}
         GROUP BY visitor.id
         ORDER BY visitor.created_at DESC, visitor.id DESC
         LIMIT ? OFFSET ?`,
        [...parameters, page_size, (page - 1) * page_size]
      );
      await recordAudit(db, {
        actorId: req.user.id,
        action: 'ALL_VISITORS_VIEWED',
        resourceType: 'all_visitor',
        resourceId: req.user.id,
        requestId: req.requestId,
        metadata: { security_status: security_status || null, has_search: Boolean(search), page, page_size }
      });
      return res.json({
        visitors: visitors.map(normalize),
        pagination: { page, page_size, total, total_pages: Math.ceil(total / page_size) }
      });
    } catch (error) {
      console.error(error);
      return sendError(res, 500, 'ALL_VISITOR_LIST_FAILED', 'Unable to list all visitors.');
    }
  }
);

router.get(
  '/all-visitors/:id',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_ALL_VISITORS),
  validate(schemas.allVisitorId),
  async (req, res) => {
    try {
      const [rows] = await db.execute(
        `${allVisitorSelect}
         WHERE visitor.id = ?
         GROUP BY visitor.id`,
        [req.params.id]
      );
      if (!rows[0]) {
        return sendError(res, 404, 'ALL_VISITOR_NOT_FOUND', 'Visitor was not found.');
      }
      await recordAudit(db, {
        actorId: req.user.id,
        action: 'ALL_VISITOR_VIEWED',
        resourceType: 'all_visitor',
        resourceId: req.params.id,
        requestId: req.requestId
      });
      return res.json({ visitor: normalize(rows[0]) });
    } catch (error) {
      console.error(error);
      return sendError(res, 500, 'ALL_VISITOR_LOAD_FAILED', 'Unable to load visitor.');
    }
  }
);

module.exports = router;
