const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authenticateToken, authorizePermission } = require('../middleware');
const { PERMISSIONS } = require('../permissions');
const { validate, schemas } = require('../validation');
const { findApplication } = require('./applicationHelpers');

const router = express.Router();

const statusExpression = `CASE
  WHEN is_lost = 1 THEN 'LOST'
  WHEN is_damaged = 1 THEN 'DAMAGED'
  WHEN is_assigned = 1 THEN 'ASSIGNED'
  WHEN is_available = 1 THEN 'AVAILABLE'
  ELSE 'UNAVAILABLE'
END`;

router.get(
  '/access-cards',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_CARDS),
  validate(schemas.cardList),
  async (req, res) => {
    try {
      const { access_level, category, status, search } = req.validatedQuery;
      const conditions = [];
      const parameters = [];
      if (access_level) {
        conditions.push('access_level = ?');
        parameters.push(access_level);
      }
      if (category) {
        conditions.push('category = ?');
        parameters.push(category);
      }
      if (status) {
        conditions.push(`${statusExpression} = ?`);
        parameters.push(status);
      }
      if (search) {
        conditions.push('(number LIKE ? OR holder_name LIKE ?)');
        parameters.push(`%${search}%`, `%${search}%`);
      }
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const [cards] = await db.execute(
        `SELECT id, number, access_level, category, ${statusExpression} AS status,
                current_application_id, last_return_date AS last_returned_at,
                holder_name, holder_phone, created_at, updated_at
         FROM access_cards
         ${whereClause}
         ORDER BY number`,
        parameters
      );
      return res.json({ cards });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Unable to list access cards.' });
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
        return res.status(409).json({ error: 'Card number already exists.' });
      }
      console.error(error);
      return res.status(500).json({ error: 'Unable to create access card.' });
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
        'SELECT * FROM access_cards WHERE number = ? LIMIT 1 FOR UPDATE',
        [req.body.card_number]
      );
      const card = cardRows[0];
      if (!card) {
        await connection.rollback();
        return res.status(404).json({ error: 'Access card not found.' });
      }
      if (card.is_lost || card.is_damaged || card.is_assigned || !card.is_available) {
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
