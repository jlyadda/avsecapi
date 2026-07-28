const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authenticateToken, authorizePermission } = require('../middleware');
const { PERMISSIONS } = require('../permissions');
const { validate, schemas } = require('../validation');
const { findApplication } = require('./applicationHelpers');
const { recordAudit } = require('../audit');
const { createSystemNotification } = require('../notificationService');

const router = express.Router();

const statusExpression = `CASE
  WHEN c.is_active = 0 THEN 'UNAVAILABLE'
  WHEN c.is_lost = 1 THEN 'LOST'
  WHEN c.is_damaged = 1 THEN 'DAMAGED'
  WHEN c.is_assigned = 1 THEN 'ASSIGNED'
  WHEN c.is_available = 1 THEN 'AVAILABLE'
  ELSE 'UNAVAILABLE'
END`;

const taxonomyIsActive = async (executor, accessLevel, category) => {
  const [[result]] = await executor.execute(
    `SELECT
       EXISTS(
         SELECT 1 FROM card_access_levels WHERE code = ? AND is_active = 1
       ) AS access_level_valid,
       EXISTS(
         SELECT 1 FROM card_categories WHERE code = ? AND is_active = 1
       ) AS category_valid`,
    [accessLevel, category]
  );
  return Boolean(result.access_level_valid && result.category_valid);
};

router.get(
  '/access-cards',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_CARDS),
  validate(schemas.cardList),
  async (req, res) => {
    try {
      const {
        access_level,
        category,
        status,
        search,
        include_inactive
      } = req.validatedQuery;
      const conditions = [];
      const parameters = [];
      if (access_level) {
        conditions.push('c.access_level = ?');
        parameters.push(access_level);
      }
      if (category) {
        conditions.push('c.category = ?');
        parameters.push(category);
      }
      if (status) {
        conditions.push(`${statusExpression} = ?`);
        parameters.push(status);
      }
      if (search) {
        conditions.push('(c.number LIKE ? OR c.holder_name LIKE ?)');
        parameters.push(`%${search}%`, `%${search}%`);
      }
      if (!include_inactive) conditions.push('c.is_active = 1');
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const [cards] = await db.execute(
        `SELECT c.id, c.number, c.access_level, level.name AS access_level_name,
                c.category, category.name AS category_name,
                ${statusExpression} AS status, c.is_active,
                c.current_application_id, c.last_return_date AS last_returned_at,
                c.holder_name, c.holder_phone, c.created_at, c.updated_at
         FROM access_cards c
         INNER JOIN card_access_levels level ON level.code = c.access_level
         INNER JOIN card_categories category ON category.code = c.category
         ${whereClause}
         ORDER BY level.sort_order, category.sort_order, c.number`,
        parameters
      );
      return res.json({
        cards: cards.map((card) => ({ ...card, is_active: Boolean(card.is_active) }))
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Unable to list access cards.' });
    }
  }
);

router.get(
  '/access-cards/:id/assignments',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_CARDS),
  validate(schemas.cardAssignmentList),
  async (req, res) => {
    try {
      const [cardRows] = await db.execute(
        'SELECT id FROM access_cards WHERE id = ?',
        [req.params.id]
      );
      if (!cardRows[0]) {
        return res.status(404).json({
          error: 'Access card not found.',
          code: 'ACCESS_CARD_NOT_FOUND'
        });
      }
      const { page, page_size } = req.validatedQuery;
      const [[countRow]] = await db.execute(
        'SELECT COUNT(*) AS total FROM card_assignments WHERE card_id = ?',
        [req.params.id]
      );
      const total = Number(countRow.total);
      const [assignments] = await db.execute(
        `SELECT ca.id, ca.card_id, ca.application_id, a.application_number,
                ca.assigned_at, ca.assigned_by,
                assigned_user.user_name AS assigned_by_user_name,
                ca.returned_at, ca.returned_by,
                returned_user.user_name AS returned_by_user_name,
                ca.return_condition, ca.status
         FROM card_assignments ca
         INNER JOIN visitor_applications a ON a.id = ca.application_id
         LEFT JOIN user_profiles assigned_user ON assigned_user.id = ca.assigned_by
         LEFT JOIN user_profiles returned_user ON returned_user.id = ca.returned_by
         WHERE ca.card_id = ?
         ORDER BY ca.assigned_at DESC
         LIMIT ? OFFSET ?`,
        [req.params.id, page_size, (page - 1) * page_size]
      );
      return res.json({
        assignments,
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
        error: 'Unable to list card assignments.',
        code: 'CARD_ASSIGNMENT_LIST_FAILED'
      });
    }
  }
);

router.post(
  '/access-cards/bulk',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_CARD_INVENTORY),
  validate(schemas.cardBulkCreate),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const taxonomyPairs = new Set(
        req.body.cards.map((card) => `${card.access_level}:${card.category}`)
      );
      for (const pair of taxonomyPairs) {
        const [accessLevel, category] = pair.split(':');
        if (!(await taxonomyIsActive(connection, accessLevel, category))) {
          await connection.rollback();
          return res.status(422).json({
            error: 'Every card must use an active access level and category.',
            code: 'CARD_TAXONOMY_INVALID'
          });
        }
      }

      const createdCards = [];
      for (const card of req.body.cards) {
        const id = uuidv4();
        await connection.execute(
          `INSERT INTO access_cards (id, number, access_level, category)
           VALUES (?, ?, ?, ?)`,
          [id, card.number, card.access_level, card.category]
        );
        await connection.execute(
          `INSERT INTO card_events (id, card_id, event_type, performed_by)
           VALUES (?, ?, 'CREATED', ?)`,
          [uuidv4(), id, req.user.id]
        );
        await recordAudit(connection, {
          actorId: req.user.id,
          action: 'ACCESS_CARD_CREATED',
          resourceType: 'access_card',
          resourceId: id,
          requestId: req.requestId,
          metadata: {
            number: card.number,
            access_level: card.access_level,
            category: card.category,
            source: 'bulk'
          }
        });
        createdCards.push({ id, ...card, status: 'AVAILABLE', is_active: true });
      }
      await connection.commit();
      return res.status(201).json({ cards: createdCards });
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          error: 'One or more card numbers already exist.',
          code: 'ACCESS_CARD_NUMBER_EXISTS'
        });
      }
      console.error(error);
      return res.status(500).json({
        error: 'Unable to create access cards.',
        code: 'ACCESS_CARD_BULK_CREATE_FAILED'
      });
    } finally {
      connection.release();
    }
  }
);

router.post(
  '/access-cards',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_CARD_INVENTORY),
  validate(schemas.cardCreate),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      if (!(await taxonomyIsActive(
        connection,
        req.body.access_level,
        req.body.category
      ))) {
        await connection.rollback();
        return res.status(422).json({
          error: 'Card must use an active access level and category.',
          code: 'CARD_TAXONOMY_INVALID'
        });
      }
      const id = uuidv4();
      await connection.execute(
        `INSERT INTO access_cards (id, number, access_level, category)
         VALUES (?, ?, ?, ?)`,
        [id, req.body.number, req.body.access_level, req.body.category]
      );
      await connection.execute(
        `INSERT INTO card_events (id, card_id, event_type, performed_by)
         VALUES (?, ?, 'CREATED', ?)`,
        [uuidv4(), id, req.user.id]
      );
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'ACCESS_CARD_CREATED',
        resourceType: 'access_card',
        resourceId: id,
        requestId: req.requestId,
        metadata: {
          number: req.body.number,
          access_level: req.body.access_level,
          category: req.body.category
        }
      });
      const [rows] = await connection.execute(
        `SELECT id, number, access_level, category, 'AVAILABLE' AS status,
                current_application_id, last_return_date AS last_returned_at
         FROM access_cards WHERE id = ?`,
        [id]
      );
      await connection.commit();
      return res.status(201).json({ card: rows[0] });
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          error: 'Card number already exists.',
          code: 'ACCESS_CARD_NUMBER_EXISTS'
        });
      }
      console.error(error);
      return res.status(500).json({ error: 'Unable to create access card.' });
    } finally {
      connection.release();
    }
  }
);

router.patch(
  '/access-cards/:id',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_CARD_INVENTORY),
  validate(schemas.cardUpdate),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT * FROM access_cards WHERE id = ? FOR UPDATE',
        [req.params.id]
      );
      const card = rows[0];
      if (!card) {
        await connection.rollback();
        return res.status(404).json({
          error: 'Access card not found.',
          code: 'ACCESS_CARD_NOT_FOUND'
        });
      }
      if (card.is_assigned) {
        await connection.rollback();
        return res.status(409).json({
          error: 'An assigned card cannot be renumbered or reclassified.',
          code: 'ACCESS_CARD_ASSIGNED'
        });
      }
      const accessLevel = req.body.access_level || card.access_level;
      const category = req.body.category || card.category;
      if (!(await taxonomyIsActive(connection, accessLevel, category))) {
        await connection.rollback();
        return res.status(422).json({
          error: 'Card must use an active access level and category.',
          code: 'CARD_TAXONOMY_INVALID'
        });
      }

      const updates = [];
      const parameters = [];
      for (const field of ['number', 'access_level', 'category']) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = ?`);
          parameters.push(req.body[field]);
        }
      }
      parameters.push(card.id);
      await connection.execute(
        `UPDATE access_cards SET ${updates.join(', ')} WHERE id = ?`,
        parameters
      );
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'ACCESS_CARD_UPDATED',
        resourceType: 'access_card',
        resourceId: card.id,
        requestId: req.requestId,
        metadata: {
          previous_number: card.number,
          changed_fields: Object.keys(req.body)
        }
      });
      await connection.commit();
      return res.json({ message: 'Access card updated.' });
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          error: 'Card number already exists.',
          code: 'ACCESS_CARD_NUMBER_EXISTS'
        });
      }
      console.error(error);
      return res.status(500).json({
        error: 'Unable to update access card.',
        code: 'ACCESS_CARD_UPDATE_FAILED'
      });
    } finally {
      connection.release();
    }
  }
);

router.patch(
  '/access-cards/:id/activation',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_CARD_INVENTORY),
  validate(schemas.cardActivation),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT * FROM access_cards WHERE id = ? FOR UPDATE',
        [req.params.id]
      );
      const card = rows[0];
      if (!card) {
        await connection.rollback();
        return res.status(404).json({
          error: 'Access card not found.',
          code: 'ACCESS_CARD_NOT_FOUND'
        });
      }
      if (card.is_assigned) {
        await connection.rollback();
        return res.status(409).json({
          error: 'An assigned card cannot be deactivated.',
          code: 'ACCESS_CARD_ASSIGNED'
        });
      }
      if (
        req.body.is_active
        && !(await taxonomyIsActive(connection, card.access_level, card.category))
      ) {
        await connection.rollback();
        return res.status(422).json({
          error: 'Reactivate the card access level and category first.',
          code: 'CARD_TAXONOMY_INVALID'
        });
      }
      const available = req.body.is_active && !card.is_damaged && !card.is_lost;
      await connection.execute(
        `UPDATE access_cards
         SET is_active = ?, is_available = ?
         WHERE id = ?`,
        [req.body.is_active, available, card.id]
      );
      await connection.execute(
        `INSERT INTO card_events (id, card_id, event_type, performed_by)
         VALUES (?, ?, ?, ?)`,
        [
          uuidv4(),
          card.id,
          req.body.is_active ? 'MARKED_AVAILABLE' : 'MARKED_UNAVAILABLE',
          req.user.id
        ]
      );
      await recordAudit(connection, {
        actorId: req.user.id,
        action: req.body.is_active
          ? 'ACCESS_CARD_ACTIVATED'
          : 'ACCESS_CARD_DEACTIVATED',
        resourceType: 'access_card',
        resourceId: card.id,
        requestId: req.requestId,
        metadata: { number: card.number }
      });
      await connection.commit();
      return res.json({
        message: req.body.is_active ? 'Access card activated.' : 'Access card deactivated.'
      });
    } catch (error) {
      await connection.rollback();
      console.error(error);
      return res.status(500).json({
        error: 'Unable to update card activation.',
        code: 'ACCESS_CARD_ACTIVATION_FAILED'
      });
    } finally {
      connection.release();
    }
  }
);

router.patch(
  '/access-cards/:id/status',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_CARD_INVENTORY),
  validate(schemas.cardCondition),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT * FROM access_cards WHERE id = ? FOR UPDATE',
        [req.params.id]
      );
      const card = rows[0];
      if (!card) {
        await connection.rollback();
        return res.status(404).json({ error: 'Access card not found.' });
      }
      if (card.is_assigned) {
        await connection.rollback();
        return res.status(409).json({ error: 'An assigned card cannot change inventory status.' });
      }
      if (!card.is_active) {
        await connection.rollback();
        return res.status(409).json({
          error: 'Reactivate the card before changing its condition.',
          code: 'ACCESS_CARD_INACTIVE'
        });
      }

      const flags = {
        AVAILABLE: [1, 0, 0],
        UNAVAILABLE: [0, 0, 0],
        DAMAGED: [0, 1, 0],
        LOST: [0, 0, 1]
      }[req.body.status];
      await connection.execute(
        `UPDATE access_cards
         SET is_available = ?, is_damaged = ?, is_lost = ?
         WHERE id = ?`,
        [...flags, card.id]
      );
      await connection.execute(
        `INSERT INTO card_events (id, card_id, event_type, performed_by)
         VALUES (?, ?, ?, ?)`,
        [uuidv4(), card.id, `MARKED_${req.body.status}`, req.user.id]
      );
      await recordAudit(connection, {
        actorId: req.user.id,
        action: `ACCESS_CARD_MARKED_${req.body.status}`,
        resourceType: 'access_card',
        resourceId: card.id,
        requestId: req.requestId,
        metadata: { number: card.number }
      });
      if (['DAMAGED', 'LOST'].includes(req.body.status)) {
        await createSystemNotification(connection, {
          templateCode: 'ACCESS_CARD_ALERT',
          values: { number: card.number, status: req.body.status.toLowerCase() },
          requestId: req.requestId,
          resourceType: 'access_card',
          resourceId: card.id,
          targets: [
            { type: 'ROLE', value: 'admin' },
            { type: 'ROLE', value: 'super_admin' },
            { type: 'ROLE', value: 'audit' }
          ],
          channels: ['IN_APP', 'EMAIL'],
          metadata: { number: card.number, status: req.body.status }
        });
      }
      await connection.commit();
      return res.json({ message: `Card marked ${req.body.status}.` });
    } catch (error) {
      await connection.rollback();
      console.error(error);
      return res.status(500).json({ error: 'Unable to update card status.' });
    } finally {
      connection.release();
    }
  }
);

router.post(
  '/visitor-applications/:reference/card-assignment',
  authenticateToken,
  authorizePermission(PERMISSIONS.ASSIGN_CARDS),
  validate(schemas.cardAssignment),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const application = await findApplication(connection, req.params.reference, true);
      if (!application) {
        await connection.rollback();
        return res.status(404).json({ error: 'Application not found.' });
      }
      if (!['APPROVED', 'CHECKED_IN'].includes(application.status)) {
        await connection.rollback();
        return res.status(409).json({
          error: `A card cannot be assigned while the application is ${application.status}.`
        });
      }
      if (!application.within_visit_period) {
        await connection.rollback();
        return res.status(409).json({ error: 'The visit is outside its approved date range.' });
      }
      if (application.card_id) {
        await connection.rollback();
        return res.status(409).json({ error: 'This application already has an assigned card.' });
      }

      const [cardRows] = await connection.execute(
        `SELECT c.*, level.is_active AS access_level_is_active,
                category.is_active AS category_is_active
         FROM access_cards c
         INNER JOIN card_access_levels level ON level.code = c.access_level
         INNER JOIN card_categories category ON category.code = c.category
         WHERE c.number = ?
         LIMIT 1 FOR UPDATE`,
        [req.body.card_number]
      );
      const card = cardRows[0];
      if (!card) {
        await connection.rollback();
        return res.status(404).json({ error: 'Access card not found.' });
      }
      if (
        !card.is_active
        || !card.access_level_is_active
        || !card.category_is_active
        || card.is_lost
        || card.is_damaged
        || card.is_assigned
        || !card.is_available
      ) {
        await connection.rollback();
        return res.status(409).json({ error: 'Access card is not available for assignment.' });
      }

      await connection.execute(
        `INSERT INTO card_assignments (id, card_id, application_id, assigned_by)
         VALUES (?, ?, ?, ?)`,
        [uuidv4(), card.id, application.id, req.user.id]
      );
      await connection.execute(
        `INSERT INTO card_events
         (id, card_id, application_id, event_type, performed_by)
         VALUES (?, ?, ?, 'ASSIGNED', ?)`,
        [uuidv4(), card.id, application.id, req.user.id]
      );
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'ACCESS_CARD_ASSIGNED',
        resourceType: 'access_card',
        resourceId: card.id,
        requestId: req.requestId,
        metadata: {
          application_id: application.id,
          application_number: application.application_number
        }
      });
      await connection.execute(
        `UPDATE access_cards
         SET current_application_id = ?, holder_name = ?, holder_phone = ?,
             is_assigned = 1, is_available = 0, is_returned = 0
         WHERE id = ?`,
        [
          application.id,
          `${application.first_name} ${application.last_name}`,
          application.personal_phone,
          card.id
        ]
      );
      await connection.commit();
      const updatedApplication = await findApplication(db, application.id);
      return res.json({ application: updatedApplication });
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'Card or application is already assigned.' });
      }
      console.error(error);
      return res.status(500).json({ error: 'Unable to assign access card.' });
    } finally {
      connection.release();
    }
  }
);

router.post(
  '/visitor-applications/:reference/card-return',
  authenticateToken,
  authorizePermission(PERMISSIONS.ASSIGN_CARDS),
  validate(schemas.cardReturn),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const application = await findApplication(connection, req.params.reference, true);
      if (!application) {
        await connection.rollback();
        return res.status(404).json({ error: 'Application not found.' });
      }

      const [assignmentRows] = await connection.execute(
        `SELECT ca.id, ca.card_id
         FROM card_assignments ca
         WHERE ca.application_id = ? AND ca.status = 'ACTIVE'
         LIMIT 1 FOR UPDATE`,
        [application.id]
      );
      const assignment = assignmentRows[0];
      if (!assignment) {
        await connection.rollback();
        return res.status(409).json({ error: 'This application has no active card assignment.' });
      }
      await connection.execute(
        'SELECT id FROM access_cards WHERE id = ? FOR UPDATE',
        [assignment.card_id]
      );
      await connection.execute(
        `UPDATE card_assignments
         SET status = 'RETURNED', returned_by = ?, returned_at = NOW(), return_condition = 'GOOD'
         WHERE id = ?`,
        [req.user.id, assignment.id]
      );
      await connection.execute(
        `INSERT INTO card_events
         (id, card_id, application_id, event_type, performed_by)
         VALUES (?, ?, ?, 'RETURNED', ?)`,
        [uuidv4(), assignment.card_id, application.id, req.user.id]
      );
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'ACCESS_CARD_RETURNED',
        resourceType: 'access_card',
        resourceId: assignment.card_id,
        requestId: req.requestId,
        metadata: {
          application_id: application.id,
          application_number: application.application_number
        }
      });
      await connection.execute(
        `UPDATE access_cards
         SET current_application_id = NULL, holder_name = NULL, holder_phone = NULL,
             is_assigned = 0, is_available = 1, is_returned = 1,
             last_return_date = NOW()
         WHERE id = ?`,
        [assignment.card_id]
      );
      await connection.commit();
      const updatedApplication = await findApplication(db, application.id);
      return res.json({ application: updatedApplication });
    } catch (error) {
      await connection.rollback();
      console.error(error);
      return res.status(500).json({ error: 'Unable to return access card.' });
    } finally {
      connection.release();
    }
  }
);

module.exports = router;
