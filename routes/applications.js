const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authenticateToken, authenticateApiKey, authorizePermission } = require('../middleware');
const { PERMISSIONS } = require('../permissions');
const { validate, schemas } = require('../validation');
const { publicApplicationLimiter } = require('../rateLimits');

const router = express.Router();

const toDateOnly = (value) => {
  if (typeof value === 'string') return value.slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const findApplication = async (executor, reference, lock = false) => {
  const [rows] = await executor.execute(
    `SELECT a.*, v.first_name, v.last_name, v.identity_type, v.identity_number,
            v.issuing_country, v.date_of_birth, v.gender, v.image_url
     FROM visitor_applications a
     INNER JOIN avsec_visitors v ON v.id = a.visitor_id
     WHERE a.id = ? OR a.application_number = ?
     LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [reference, reference]
  );
  return rows[0];
};

router.post(
  '/public/visitor-applications',
  authenticateApiKey('VISITOR_APPLICATION'),
  publicApplicationLimiter,
  validate(schemas.publicApplication),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const body = req.body;

      const [visitorResult] = await connection.execute(
        `INSERT INTO avsec_visitors
         (first_name, last_name, identity_type, identity_number, issuing_country,
          date_of_birth, company, company_position, image_url, gender, security_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
        [
          body.first_name,
          body.last_name,
          body.identity_type,
          body.identity_number,
          body.issuing_country,
          body.date_of_birth,
          body.company,
          body.company_position,
          body.image_url,
          body.gender
        ]
      );

      const visitorId = visitorResult.insertId;
      const [visitorRows] = await connection.execute(
        `SELECT first_name, last_name, date_of_birth, security_status
         FROM avsec_visitors WHERE id = ?`,
        [visitorId]
      );
      const visitor = visitorRows[0];
      const submittedBirthDate = body.date_of_birth;

      if (
        visitor.first_name.toLowerCase() !== body.first_name.toLowerCase() ||
        visitor.last_name.toLowerCase() !== body.last_name.toLowerCase() ||
        toDateOnly(visitor.date_of_birth) !== submittedBirthDate
      ) {
        const mismatchError = new Error('Identity details do not match the existing visitor record.');
        mismatchError.status = 409;
        throw mismatchError;
      }
      if (visitor.security_status !== 'ACTIVE') {
        const blockedError = new Error('This visitor cannot submit an application.');
        blockedError.status = 403;
        throw blockedError;
      }

      const applicationId = uuidv4();
      const datePart = new Date().toISOString().slice(0, 10).replaceAll('-', '');
      const applicationNumber = `AVSEC-${datePart}-${applicationId.slice(0, 8).toUpperCase()}`;

      await connection.execute(
        `INSERT INTO visitor_applications
         (id, application_number, visitor_id, email, phone, company, company_position,
          purpose, host_name, host_email, expected_arrival, expected_departure, source_key_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          applicationId,
          applicationNumber,
          visitorId,
          body.email,
          body.phone,
          body.company || null,
          body.company_position || null,
          body.purpose,
          body.host_name,
          body.host_email,
          body.expected_arrival,
          body.expected_departure,
          req.apiClient.keyFingerprint
        ]
      );

      await connection.commit();
      return res.status(202).json({
        applicationId,
        applicationNumber,
        status: 'SUBMITTED',
        message: 'Visitor application submitted for review.'
      });
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'A matching application already exists.' });
      }
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error(error);
      return res.status(500).json({ error: 'Unable to submit visitor application.' });
    } finally {
      connection.release();
    }
  }
);

router.get(
  '/visitor-applications/:reference',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_APPLICATIONS),
  validate(schemas.applicationReference),
  async (req, res) => {
    try {
      const application = await findApplication(db, req.params.reference);
      if (!application) return res.status(404).json({ error: 'Application not found.' });
      return res.json({ application });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Unable to load visitor application.' });
    }
  }
);

router.patch(
  '/visitor-applications/:reference/decision',
  authenticateToken,
  authorizePermission(PERMISSIONS.REVIEW_APPLICATIONS),
  validate(schemas.applicationDecision),
  async (req, res) => {
    try {
      const [result] = await db.execute(
        `UPDATE visitor_applications
         SET status = ?, review_notes = ?, reviewed_by = ?, reviewed_at = NOW()
         WHERE (id = ? OR application_number = ?) AND status = 'SUBMITTED'`,
        [
          req.body.decision,
          req.body.notes || null,
          req.user.id,
          req.params.reference,
          req.params.reference
        ]
      );

      if (result.affectedRows === 0) {
        const application = await findApplication(db, req.params.reference);
        if (!application) return res.status(404).json({ error: 'Application not found.' });
        return res.status(409).json({ error: `Application cannot be reviewed from ${application.status}.` });
      }

      return res.json({ status: req.body.decision, message: 'Application decision recorded.' });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Unable to review visitor application.' });
    }
  }
);

router.post(
  '/visitor-applications/:reference/check-in',
  authenticateToken,
  authorizePermission(PERMISSIONS.CHECK_IN_OUT),
  validate(schemas.applicationCheckIn),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const application = await findApplication(connection, req.params.reference, true);
      if (!application) {
        await connection.rollback();
        return res.status(404).json({ error: 'Application not found.' });
      }
      if (application.status !== 'APPROVED') {
        await connection.rollback();
        return res.status(409).json({ error: `Application cannot check in from ${application.status}.` });
      }

      await connection.execute(
        `INSERT INTO visit_sessions
         (application_id, visitor_id, checked_in_by, gate, status)
         VALUES (?, ?, ?, ?, 'CHECKED_IN')`,
        [application.id, application.visitor_id, req.user.id, req.body.gate || null]
      );
      await connection.execute(
        "UPDATE visitor_applications SET status = 'CHECKED_IN' WHERE id = ?",
        [application.id]
      );
      await connection.commit();
      return res.json({ status: 'CHECKED_IN', message: 'Visitor checked in.' });
    } catch (error) {
      await connection.rollback();
      console.error(error);
      return res.status(500).json({ error: 'Unable to check in visitor.' });
    } finally {
      connection.release();
    }
  }
);

router.post(
  '/visitor-applications/:reference/check-out',
  authenticateToken,
  authorizePermission(PERMISSIONS.CHECK_IN_OUT),
  validate(schemas.applicationCheckOut),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const application = await findApplication(connection, req.params.reference, true);
      if (!application) {
        await connection.rollback();
        return res.status(404).json({ error: 'Application not found.' });
      }
      if (application.status !== 'CHECKED_IN') {
        await connection.rollback();
        return res.status(409).json({ error: `Application cannot check out from ${application.status}.` });
      }

      await connection.execute(
        `UPDATE visit_sessions
         SET checked_out_at = NOW(), checked_out_by = ?, status = 'CHECKED_OUT'
         WHERE application_id = ? AND status = 'CHECKED_IN'`,
        [req.user.id, application.id]
      );
      await connection.execute(
        "UPDATE visitor_applications SET status = 'CHECKED_OUT' WHERE id = ?",
        [application.id]
      );
      await connection.execute(
        'UPDATE avsec_visitors SET last_visit = CURDATE() WHERE id = ?',
        [application.visitor_id]
      );
      await connection.commit();
      return res.json({ status: 'CHECKED_OUT', message: 'Visitor checked out.' });
    } catch (error) {
      await connection.rollback();
      console.error(error);
      return res.status(500).json({ error: 'Unable to check out visitor.' });
    } finally {
      connection.release();
    }
  }
);

module.exports = router;
