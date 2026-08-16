const express = require('express');
const db = require('../db');
const { authenticateToken, authorizePermission } = require('../middleware');
const { PERMISSIONS } = require('../permissions');
const { validate, schemas } = require('../validation');
const { findApplication } = require('./applicationHelpers');
const {
  assignAccessCard,
  returnAccessCard
} = require('../services/cardAssignmentService');

const router = express.Router();

const toDateOnly = (value) => {
  if (!value || typeof value === 'string') return value?.slice(0, 10) || null;
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const normalizeApprovedVisitor = (visitor) => {
  if (!visitor) return visitor;
  let approvedAreas = visitor.approved_areas_of_access;
  if (typeof approvedAreas === 'string') {
    try {
      approvedAreas = JSON.parse(approvedAreas);
    } catch {
      approvedAreas = [];
    }
  }
  return {
    ...visitor,
    valid_from: toDateOnly(visitor.valid_from),
    valid_until: toDateOnly(visitor.valid_until),
    approved_areas_of_access: Array.isArray(approvedAreas) ? approvedAreas : []
  };
};

const assignmentEligibilitySql = `(
  approved_visitor.status = 'APPROVED'
  AND CURDATE() BETWEEN approved_visitor.valid_from AND approved_visitor.valid_until
  AND card.id IS NULL
  AND EXISTS (
    SELECT 1
    FROM application_approved_access_areas approved_area
    INNER JOIN access_areas area ON area.code = approved_area.area_code
    WHERE approved_area.application_id = approved_visitor.application_id
      AND area.is_active = 1
  )
)`;

const approvedVisitorSelect = `
  SELECT approved_visitor.id, approved_visitor.application_id,
         approved_visitor.visitor_profile_id,
         approved_visitor.application_number, approved_visitor.full_name,
         approved_visitor.company, approved_visitor.email, approved_visitor.phone,
         approved_visitor.approved_areas_of_access,
         approved_visitor.visit_reasons, approved_visitor.areas_of_access,
         approved_visitor.valid_from, approved_visitor.valid_until,
         approved_visitor.status, approved_visitor.approved_at,
         approved_visitor.approved_by AS approved_by_id,
         COALESCE(approver.full_name, approver.user_name) AS approved_by,
         profile.first_name, profile.last_name, profile.other_names,
         profile.identity_type, profile.identity_number, profile.issuing_country,
         profile.date_of_birth, profile.gender, profile.image_url,
         card.id AS card_id, card.number AS card_number,
         card.access_level AS card_access_level,
         card.category AS card_category,
         CASE
           WHEN card.id IS NULL THEN NULL
           WHEN card.is_lost = 1 THEN 'LOST'
           WHEN card.is_damaged = 1 THEN 'DAMAGED'
           WHEN card.is_assigned = 1 THEN 'ASSIGNED'
           ELSE 'AVAILABLE'
         END AS card_status,
         CURDATE() BETWEEN approved_visitor.valid_from AND approved_visitor.valid_until
           AS within_valid_period,
         ${assignmentEligibilitySql} AS pass_assignment_eligible
  FROM visitors approved_visitor
  INNER JOIN avsec_visitors profile
    ON profile.id = approved_visitor.visitor_profile_id
  LEFT JOIN user_profiles approver ON approver.id = approved_visitor.approved_by
  LEFT JOIN access_cards card
    ON card.current_application_id = approved_visitor.application_id`;

router.get(
  '/visitors',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_APPROVED_VISITORS),
  validate(schemas.approvedVisitorList),
  async (req, res) => {
    try {
      const {
        search,
        status,
        valid_on,
        eligible_for_card_assignment,
        page,
        page_size
      } = req.validatedQuery;
      const conditions = [];
      const values = [];
      if (search) {
        const value = `%${search}%`;
        conditions.push(`(
          approved_visitor.application_number LIKE ?
          OR approved_visitor.full_name LIKE ?
          OR profile.identity_number LIKE ?
          OR approved_visitor.company LIKE ?
          OR card.number LIKE ?
        )`);
        values.push(...Array(5).fill(value));
      }
      if (status) {
        conditions.push('approved_visitor.status = ?');
        values.push(status);
      }
      if (valid_on) {
        conditions.push('? BETWEEN approved_visitor.valid_from AND approved_visitor.valid_until');
        values.push(valid_on);
      }
      if (eligible_for_card_assignment !== undefined) {
        conditions.push(
          eligible_for_card_assignment
            ? assignmentEligibilitySql
            : `NOT ${assignmentEligibilitySql}`
        );
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const [[count]] = await db.execute(
        `SELECT COUNT(*) AS total
         FROM visitors approved_visitor
         INNER JOIN avsec_visitors profile
           ON profile.id = approved_visitor.visitor_profile_id
         LEFT JOIN access_cards card
           ON card.current_application_id = approved_visitor.application_id
         ${where}`,
        values
      );
      const total = Number(count.total);
      const [visitors] = await db.execute(
        `${approvedVisitorSelect}
         ${where}
         ORDER BY approved_visitor.approved_at DESC
         LIMIT ? OFFSET ?`,
        [...values, page_size, (page - 1) * page_size]
      );
      return res.json({
        visitors: visitors.map(normalizeApprovedVisitor),
        pagination: {
          page,
          page_size,
          total,
          total_pages: Math.ceil(total / page_size)
        }
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({
        error: 'Unable to list approved visitors.',
        code: 'APPROVED_VISITOR_LIST_FAILED'
      });
    }
  }
);

router.get(
  '/visitors/:id',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_APPROVED_VISITORS),
  validate(schemas.approvedVisitorId),
  async (req, res) => {
    try {
      const [rows] = await db.execute(
        `${approvedVisitorSelect} WHERE approved_visitor.id = ? LIMIT 1`,
        [req.params.id]
      );
      if (!rows[0]) {
        return res.status(404).json({
          error: 'Approved visitor not found.',
          code: 'APPROVED_VISITOR_NOT_FOUND'
        });
      }
      return res.json({ visitor: normalizeApprovedVisitor(rows[0]) });
    } catch (error) {
      console.error(error);
      return res.status(500).json({
        error: 'Unable to load approved visitor.',
        code: 'APPROVED_VISITOR_LOAD_FAILED'
      });
    }
  }
);

const resolveVisitorApplication = async (executor, visitorId) => {
  const [rows] = await executor.execute(
    'SELECT application_id FROM visitors WHERE id = ?',
    [visitorId]
  );
  return rows[0]?.application_id;
};

router.post(
  '/visitors/:id/card-assignment',
  authenticateToken,
  authorizePermission(PERMISSIONS.ASSIGN_CARDS),
  validate(schemas.approvedVisitorCardAssignment),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const applicationId = await resolveVisitorApplication(connection, req.params.id);
      if (!applicationId) {
        await connection.rollback();
        return res.status(404).json({
          error: 'Approved visitor not found.',
          code: 'APPROVED_VISITOR_NOT_FOUND'
        });
      }
      const application = await findApplication(connection, applicationId, true);
      await assignAccessCard(connection, {
        application,
        cardNumber: req.body.card_number,
        identityDocumentRetained: req.body.identity_document_retained,
        actorId: req.user.id,
        requestId: req.requestId
      });
      await connection.commit();
      const [rows] = await db.execute(
        `${approvedVisitorSelect} WHERE approved_visitor.id = ? LIMIT 1`,
        [req.params.id]
      );
      return res.json({ visitor: normalizeApprovedVisitor(rows[0]) });
    } catch (error) {
      await connection.rollback();
      if (error.status) {
        return res.status(error.status).json({
          error: error.message,
          code: error.code,
          missing_areas: error.missingAreas
        });
      }
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          error: 'Card or visitor is already assigned.',
          code: 'ACCESS_CARD_ASSIGNMENT_CONFLICT'
        });
      }
      console.error(error);
      return res.status(500).json({
        error: 'Unable to assign visitor access card.',
        code: 'APPROVED_VISITOR_CARD_ASSIGNMENT_FAILED'
      });
    } finally {
      connection.release();
    }
  }
);

router.post(
  '/visitors/:id/card-return',
  authenticateToken,
  authorizePermission(PERMISSIONS.ASSIGN_CARDS),
  validate(schemas.approvedVisitorCardReturn),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const applicationId = await resolveVisitorApplication(connection, req.params.id);
      if (!applicationId) {
        await connection.rollback();
        return res.status(404).json({
          error: 'Approved visitor not found.',
          code: 'APPROVED_VISITOR_NOT_FOUND'
        });
      }
      const application = await findApplication(connection, applicationId, true);
      await returnAccessCard(connection, {
        application,
        identityDocumentReturned: req.body.identity_document_returned,
        returnCondition: req.body.return_condition,
        actorId: req.user.id,
        requestId: req.requestId
      });
      await connection.commit();
      const [rows] = await db.execute(
        `${approvedVisitorSelect} WHERE approved_visitor.id = ? LIMIT 1`,
        [req.params.id]
      );
      return res.json({ visitor: normalizeApprovedVisitor(rows[0]) });
    } catch (error) {
      await connection.rollback();
      if (error.status) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      console.error(error);
      return res.status(500).json({
        error: 'Unable to return visitor access card.',
        code: 'APPROVED_VISITOR_CARD_RETURN_FAILED'
      });
    } finally {
      connection.release();
    }
  }
);

router.get(
  '/admin/stats',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_ADMIN_STATS),
  async (req, res) => {
    try {
      const [[applicationCounts], [pendingUsers]] = await Promise.all([
        db.execute(
          `SELECT COUNT(*) AS total,
                  SUM(status = 'SUBMITTED') AS submitted,
                  SUM(status = 'APPROVED') AS approved,
                  SUM(status = 'CHECKED_IN') AS checked_in
           FROM visitor_applications`
        ),
        db.execute('SELECT COUNT(*) AS pending_users FROM user_profiles WHERE is_active = 0')
      ]);

      return res.json({
        applications: applicationCounts[0],
        pending_users: pendingUsers[0].pending_users
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Unable to load administrative statistics.' });
    }
  }
);

module.exports = router;
