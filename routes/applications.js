const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authenticateToken, authenticateApiKey, authorizePermission } = require('../middleware');
const { PERMISSIONS } = require('../permissions');
const { validate, schemas } = require('../validation');
const { publicApplicationLimiter } = require('../rateLimits');
const {
  applicationSelect,
  findApplication,
  normalizeApplication
} = require('./applicationHelpers');
const { recordAudit } = require('../audit');
const { createSystemNotification } = require('../services/notificationService');
const {
  executeVisitorWorkflowAction,
  startVisitorWorkflow
} = require('../services/workflowService');

const router = express.Router();

const toDateOnly = (value) => {
  if (typeof value === 'string') return value.slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

//external app route for visitor application submition
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
         (first_name, last_name, other_names, identity_type, identity_number, issuing_country,
          date_of_birth, identity_expiry_date, company, company_position, image_url,
          gender, security_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
        [
          body.first_name,
          body.last_name,
          body.other_names,
          body.identity_type,
          body.identity_number,
          body.issuing_country,
          body.date_of_birth,
          body.identity_expiry_date,
          body.company || null,
          body.company_position || null,
          body.image_url || body.supporting_documents.passport_photograph_url,
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
         (id, application_number, visitor_id, personal_email, personal_phone,
          alternative_personal_phone, identity_expiry_date, company_name, company_position,
          company_address, company_phone, company_email, areas_of_access,
          supporting_documents, visit_reasons, visit_starts, visit_ends, source_key_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          applicationId,
          applicationNumber,
          visitorId,
          body.personal_email,
          body.personal_phone,
          body.alternative_personal_phone,
          body.identity_expiry_date,
          body.company,
          body.company_position,
          body.company_address,
          body.company_phone,
          body.company_email,
          JSON.stringify(body.areas_of_access),
          JSON.stringify(body.supporting_documents),
          JSON.stringify(body.visit_reasons),
          body.visit_starts,
          body.visit_ends,
          req.apiClient.keyFingerprint
        ]
      );
      await startVisitorWorkflow(
        connection,
        {
          id: applicationId,
          application_number: applicationNumber,
          personal_email: body.personal_email
        },
        req.requestId
      );
      await recordAudit(connection, {
        action: 'VISITOR_APPLICATION_SUBMITTED',
        resourceType: 'visitor_application',
        resourceId: applicationId,
        requestId: req.requestId,
        metadata: { application_number: applicationNumber, source: 'external_api_key' }
      });

      await connection.commit();
      return res.status(202).json({
        applicationId,
        applicationNumber,
        status: 'SUBMITTED',
        message: `Success, visitor application submitted for review.`
      });
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'A matching application already exists, please wait for security review proccess.' });
      }
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error(error);
      return res.status(500).json({ error: 'Unable to submit visitor application, please try again later.' });
    } finally {
      connection.release();
    }
  }
);

router.get(
  '/visitor-applications',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_APPLICATIONS),
  validate(schemas.applicationList),
  async (req, res) => {
    try {
      const { search, status, visit_from, visit_to, page, page_size } = req.validatedQuery;
      const conditions = [];
      const parameters = [];

      if (search) {
        const searchValue = `%${search}%`;
        conditions.push(`(
          a.application_number LIKE ? OR v.first_name LIKE ? OR v.last_name LIKE ?
          OR v.other_names LIKE ? OR v.identity_number LIKE ? OR a.company_name LIKE ?
        )`);
        parameters.push(...Array(6).fill(searchValue));
      }
      if (status) {
        conditions.push('a.status = ?');
        parameters.push(status);
      }
      if (visit_from) {
        conditions.push('a.visit_ends >= ?');
        parameters.push(visit_from);
      }
      if (visit_to) {
        conditions.push('a.visit_starts <= ?');
        parameters.push(visit_to);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const [countRows] = await db.execute(
        `SELECT COUNT(*) AS total
         FROM visitor_applications a
         INNER JOIN avsec_visitors v ON v.id = a.visitor_id
         ${whereClause}`,
        parameters
      );
      const total = Number(countRows[0].total);
      const offset = (page - 1) * page_size;
      const [applications] = await db.execute(
        `${applicationSelect}
         ${whereClause}
         ORDER BY a.created_at DESC
         LIMIT ? OFFSET ?`,
        [...parameters, page_size, offset]
      );

      return res.json({
        applications: applications.map(normalizeApplication),
        pagination: {
          page,
          page_size,
          total,
          total_pages: Math.ceil(total / page_size)
        }
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Unable to list visitor applications.' });
    }
  }
);

router.post(
  '/visitor-applications',
  authenticateToken,
  authorizePermission(PERMISSIONS.CREATE_APPLICATIONS),
  validate(schemas.internalApplication),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const body = req.body;
      const documents = body.supporting_documents || {};
      const imageUrl = body.image_url || documents.passport_photograph_url || null;

      const [visitorResult] = await connection.execute(
        `INSERT INTO avsec_visitors
         (first_name, last_name, other_names, identity_type, identity_number, issuing_country,
          date_of_birth, identity_expiry_date, company, company_position, image_url,
          gender, security_status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
        [
          body.first_name,
          body.last_name,
          body.other_names || null,
          body.identity_type,
          body.identity_number,
          body.issuing_country,
          body.date_of_birth,
          body.identity_expiry_date || null,
          body.company_name,
          body.company_position || null,
          imageUrl,
          body.gender,
          req.user.id
        ]
      );

      const visitorId = visitorResult.insertId;
      const [visitorRows] = await connection.execute(
        `SELECT first_name, last_name, date_of_birth, security_status
         FROM avsec_visitors WHERE id = ? FOR UPDATE`,
        [visitorId]
      );
      const visitor = visitorRows[0];

      if (
        visitor.first_name.toLowerCase() !== body.first_name.toLowerCase()
        || visitor.last_name.toLowerCase() !== body.last_name.toLowerCase()
        || toDateOnly(visitor.date_of_birth) !== body.date_of_birth
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
         (id, application_number, visitor_id, personal_email, personal_phone,
          alternative_personal_phone, identity_expiry_date, company_name, company_position,
          company_address, company_phone, company_email, areas_of_access,
          supporting_documents, visit_reasons, visit_starts, visit_ends, source_key_hash,
          submitted_by, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 'INTERNAL_STAFF', ?, 'SUBMITTED')`,
        [
          applicationId,
          applicationNumber,
          visitorId,
          body.personal_email,
          body.personal_phone,
          body.alternative_personal_phone || null,
          body.identity_expiry_date || null,
          body.company_name,
          body.company_position || null,
          body.company_address || null,
          body.company_phone || null,
          body.company_email || null,
          JSON.stringify(body.areas_of_access || []),
          JSON.stringify(documents),
          JSON.stringify(body.visit_reasons),
          body.visit_starts,
          body.visit_ends,
          req.user.id
        ]
      );
      await startVisitorWorkflow(
        connection,
        {
          id: applicationId,
          application_number: applicationNumber,
          personal_email: body.personal_email
        },
        req.requestId
      );
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'VISITOR_APPLICATION_CREATED',
        resourceType: 'visitor_application',
        resourceId: applicationId,
        requestId: req.requestId,
        metadata: { application_number: applicationNumber, source: 'internal_staff' }
      });

      await connection.commit();
      const application = await findApplication(db, applicationId);
      return res.status(201).json({ application });
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'A matching application already exists.' });
      }
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error(error);
      return res.status(500).json({ error: 'Unable to create visitor application.' });
    } finally {
      connection.release();
    }
  }
);

//
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


//
router.patch(
  '/visitor-applications/:reference/decision',
  authenticateToken,
  authorizePermission(PERMISSIONS.REVIEW_APPLICATIONS),
  validate(schemas.applicationDecision),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const application = await findApplication(connection, req.params.reference, true);
      if (!application) {
        await connection.rollback();
        return res.status(404).json({ error: 'Application not found.' });
      }
      const result = await executeVisitorWorkflowAction(connection, {
        application,
        user: req.user,
        action: req.body.decision === 'APPROVED' ? 'APPROVE' : 'REJECT',
        notes: req.body.notes,
        requestId: req.requestId
      });
      await recordAudit(connection, {
        actorId: req.user.id,
        action: `VISITOR_WORKFLOW_STAGE_${
          req.body.decision === 'APPROVED' ? 'APPROVE' : 'REJECT'
        }`,
        resourceType: 'visitor_application',
        resourceId: application.id,
        requestId: req.requestId,
        metadata: {
          application_number: application.application_number,
          stage: result.actedStage.code,
          resulting_status: result.status,
          legacy_endpoint: true
        }
      });
      if (result.completed) {
        await createSystemNotification(connection, {
          templateCode: 'VISITOR_WORKFLOW_COMPLETED',
          values: {
            reference: application.application_number,
            decision: result.status.toLowerCase()
          },
          requestId: req.requestId,
          resourceType: 'visitor_application',
          resourceId: application.id,
          targets: [
            { type: 'EXTERNAL_EMAIL', value: application.personal_email }
          ],
          channels: ['EMAIL'],
          metadata: {
            application_number: application.application_number,
            decision: result.status
          }
        });
      }
      await connection.commit();
      const updatedApplication = await findApplication(db, application.id);
      return res.json({
        application: updatedApplication,
        status: result.status,
        message: result.completed
          ? 'Application workflow completed.'
          : 'Stage decision recorded and application moved to the next stage.'
      });
    } catch (error) {
      await connection.rollback();
      if (error.status) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      console.error(error);
      return res.status(500).json({ error: 'Unable to review visitor application.' });
    } finally {
      connection.release();
    }
  }
);


//
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
      if (!application.within_visit_period) {
        await connection.rollback();
        return res.status(409).json({ error: 'The approved visit is outside its valid date range.' });
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
      await connection.execute(
        "UPDATE visitors SET status = 'CHECKED_IN' WHERE application_id = ?",
        [application.id]
      );
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'VISITOR_CHECKED_IN',
        resourceType: 'visitor_application',
        resourceId: application.id,
        requestId: req.requestId,
        metadata: {
          application_number: application.application_number,
          gate: req.body.gate || null
        }
      });
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


//
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

      const [activeAssignments] = await connection.execute(
        `SELECT id FROM card_assignments
         WHERE application_id = ? AND status = 'ACTIVE'
         LIMIT 1 FOR UPDATE`,
        [application.id]
      );
      if (activeAssignments.length > 0) {
        await connection.rollback();
        return res.status(409).json({ error: 'Return the assigned access card before check-out.' });
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
        "UPDATE visitors SET status = 'CHECKED_OUT' WHERE application_id = ?",
        [application.id]
      );
      await connection.execute(
        'UPDATE avsec_visitors SET last_visit = CURDATE() WHERE id = ?',
        [application.visitor_id]
      );
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'VISITOR_CHECKED_OUT',
        resourceType: 'visitor_application',
        resourceId: application.id,
        requestId: req.requestId,
        metadata: { application_number: application.application_number }
      });
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
