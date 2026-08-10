const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const {
  authenticateApiKey,
  authenticateToken,
  authorizePermission
} = require('../middleware');
const { validate, schemas } = require('../validation');
const { publicApplicationLimiter } = require('../rateLimits');
const { PERMISSIONS } = require('../permissions');
const { recordAudit, sendError } = require('../audit');
const { createSystemNotification } = require('../services/notificationService');

const router = express.Router();

const normalizeName = (value) => value.toLowerCase().trim().split(/\s+/);

const vehicleApplicationSelect = `
  SELECT a.*, v.identity_type, v.identity_number, v.issuing_country,
         a.reviewed_by AS reviewed_by_id,
         COALESCE(reviewer.full_name, reviewer.user_name) AS reviewed_by,
         permit_user.user_name AS used_by_user_name
  FROM vehicle_access_applications a
  INNER JOIN avsec_visitors v ON v.id = a.driver_visitor_id
  LEFT JOIN user_profiles reviewer ON reviewer.id = a.reviewed_by
  LEFT JOIN user_profiles permit_user ON permit_user.id = a.used_by`;

const findVehicleApplication = async (executor, reference, lock = false) => {
  const [rows] = await executor.execute(
    `${vehicleApplicationSelect}
     WHERE a.id = ? OR a.reference = ?
     LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [reference, reference]
  );
  return rows[0];
};

router.post(
  '/public/vehicle-access-applications',
  authenticateApiKey('VEHICLE_ACCESS_APPLICATION'),
  publicApplicationLimiter,
  validate(schemas.vehicleAccessApplication),
  async (req, res) => {
    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();
      const [[clock]] = await connection.query(
        `SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS application_date,
                DATE_FORMAT(TIMESTAMP(?, ?), '%Y-%m-%d %H:%i:%s') AS access_starts_at,
                DATE_FORMAT(
                  DATE_ADD(TIMESTAMP(?, ?), INTERVAL ? HOUR),
                  '%Y-%m-%d %H:%i:%s'
                ) AS access_ends_at,
                TIMESTAMP(?, ?) >= DATE_ADD(NOW(), INTERVAL 24 HOUR) AS notice_is_valid`,
        [
          req.body.date_of_access,
          `${req.body.time_of_access}:00`,
          req.body.date_of_access,
          `${req.body.time_of_access}:00`,
          req.body.duration_of_access_hours,
          req.body.date_of_access,
          `${req.body.time_of_access}:00`
        ]
      );

      if (!clock.notice_is_valid) {
        await connection.rollback();
        return res.status(400).json({
          error: 'Vehicle access must start at least 24 hours after the application is submitted.'
        });
      }

      const [drivers] = await connection.execute(
        `SELECT v.id, v.first_name, v.last_name, v.other_names
         FROM avsec_visitors v
         INNER JOIN visitor_applications a ON a.visitor_id = v.id
         WHERE v.identity_type = 'NATIONAL_ID'
           AND v.issuing_country = 'UGANDA'
           AND v.identity_number = ?
           AND v.security_status = 'ACTIVE'
           AND a.status IN ('APPROVED', 'CHECKED_IN')
           AND ? >= TIMESTAMP(COALESCE(a.approved_visit_starts, a.visit_starts), '00:00:00')
           AND ? <= DATE_ADD(
             TIMESTAMP(COALESCE(a.approved_visit_ends, a.visit_ends), '00:00:00'),
             INTERVAL 1 DAY
           )
         LIMIT 1
         FOR UPDATE`,
        [
          req.body.driver_national_id_number,
          clock.access_starts_at,
          clock.access_ends_at
        ]
      );
      const driver = drivers[0];

      if (!driver) {
        await connection.rollback();
        return res.status(422).json({
          error: 'Driver is not an accepted visitor with valid access on the requested date.'
        });
      }

      const submittedNameParts = new Set(normalizeName(req.body.driver_name));
      if (
        !submittedNameParts.has(driver.first_name.toLowerCase()) ||
        !submittedNameParts.has(driver.last_name.toLowerCase())
      ) {
        await connection.rollback();
        return res.status(409).json({
          error: 'Driver name does not match the accepted visitor record.'
        });
      }

      const applicationId = uuidv4();
      const reference = `VAP-${applicationId.slice(0, 8).toUpperCase()}`;
      const canonicalDriverName = [
        driver.first_name,
        driver.other_names,
        driver.last_name
      ].filter(Boolean).join(' ');

      await connection.execute(
        `INSERT INTO vehicle_access_applications
         (id, reference, driver_visitor_id, driver_name, vehicle_registration_number,
          vehicle_type, company, reason_for_access, access_gate, date_of_access, time_of_access,
          duration_of_access_hours, access_starts_at, access_ends_at,
          application_date, external_api_key_id, source_key_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          applicationId,
          reference,
          driver.id,
          canonicalDriverName,
          req.body.vehicle_registration_number,
          req.body.vehicle_type,
          req.body.company,
          req.body.reason_for_access,
          req.body.access_gate,
          req.body.date_of_access,
          `${req.body.time_of_access}:00`,
          req.body.duration_of_access_hours,
          clock.access_starts_at,
          clock.access_ends_at,
          clock.application_date,
          req.apiClient.id || null,
          req.apiClient.keyFingerprint
        ]
      );
      await recordAudit(connection, {
        action: 'VEHICLE_APPLICATION_SUBMITTED',
        resourceType: 'vehicle_access_application',
        resourceId: applicationId,
        requestId: req.requestId,
        metadata: { reference, source: 'external_api_key' }
      });
      await createSystemNotification(connection, {
        templateCode: 'VEHICLE_APPLICATION_SUBMITTED',
        values: { reference },
        requestId: req.requestId,
        resourceType: 'vehicle_access_application',
        resourceId: applicationId,
        targets: [
          { type: 'ROLE', value: 'supervisor' },
          { type: 'ROLE', value: 'admin' },
          { type: 'ROLE', value: 'super_admin' }
        ],
        channels: ['IN_APP', 'EMAIL'],
        metadata: { reference }
      });

      await connection.commit();
      return res.status(202).json({
        applicationId,
        reference,
        applicationDate: clock.application_date,
        dateOfAccess: req.body.date_of_access,
        timeOfAccess: req.body.time_of_access,
        durationOfAccessHours: req.body.duration_of_access_hours,
        accessEndsAt: clock.access_ends_at,
        status: 'SUBMITTED',
        message: 'Vehicle access application submitted for review.'
      });
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          error: 'This vehicle already has an application for the requested date.'
        });
      }
      console.error(error);
      return res.status(500).json({ error: 'Unable to submit vehicle access application.' });
    } finally {
      connection.release();
    }
  }
);

router.get(
  '/vehicle-access-applications',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_VEHICLE_APPLICATIONS),
  validate(schemas.vehicleApplicationList),
  async (req, res) => {
    try {
      const { search, status, visit_from, visit_to, page, page_size } = req.validatedQuery;
      const conditions = [];
      const parameters = [];
      if (search) {
        const value = `%${search}%`;
        conditions.push(`(
          a.reference LIKE ? OR a.driver_name LIKE ? OR v.identity_number LIKE ?
          OR a.vehicle_registration_number LIKE ? OR a.company LIKE ?
        )`);
        parameters.push(...Array(5).fill(value));
      }
      if (status) {
        conditions.push('a.status = ?');
        parameters.push(status);
      }
      if (visit_from) {
        conditions.push('a.date_of_access >= ?');
        parameters.push(visit_from);
      }
      if (visit_to) {
        conditions.push('a.date_of_access <= ?');
        parameters.push(visit_to);
      }
      const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const [[countRow]] = await db.execute(
        `SELECT COUNT(*) AS total
         FROM vehicle_access_applications a
         INNER JOIN avsec_visitors v ON v.id = a.driver_visitor_id
         ${whereClause}`,
        parameters
      );
      const total = Number(countRow.total);
      const [applications] = await db.execute(
        `${vehicleApplicationSelect}
         ${whereClause}
         ORDER BY a.created_at DESC
         LIMIT ? OFFSET ?`,
        [...parameters, page_size, (page - 1) * page_size]
      );
      return res.json({
        applications,
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
        'VEHICLE_APPLICATION_LIST_FAILED',
        'Unable to list vehicle access applications.'
      );
    }
  }
);

router.get(
  '/vehicle-access-applications/:reference',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_VEHICLE_APPLICATIONS),
  validate(schemas.vehicleApplicationReference),
  async (req, res) => {
    try {
      const application = await findVehicleApplication(db, req.params.reference);
      if (!application) {
        return sendError(res, 404, 'VEHICLE_APPLICATION_NOT_FOUND', 'Application not found.');
      }
      return res.json({ application });
    } catch (error) {
      console.error(error);
      return sendError(
        res,
        500,
        'VEHICLE_APPLICATION_LOAD_FAILED',
        'Unable to load vehicle access application.'
      );
    }
  }
);

router.patch(
  '/vehicle-access-applications/:reference/decision',
  authenticateToken,
  authorizePermission(PERMISSIONS.REVIEW_VEHICLE_APPLICATIONS),
  validate(schemas.vehicleApplicationDecision),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const application = await findVehicleApplication(
        connection,
        req.params.reference,
        true
      );
      if (!application) {
        await connection.rollback();
        return sendError(res, 404, 'VEHICLE_APPLICATION_NOT_FOUND', 'Application not found.');
      }
      if (application.status !== 'SUBMITTED') {
        await connection.rollback();
        return sendError(
          res,
          409,
          'INVALID_VEHICLE_APPLICATION_TRANSITION',
          `Application cannot be reviewed from ${application.status}.`
        );
      }
      await connection.execute(
        `UPDATE vehicle_access_applications
         SET status = ?, review_notes = ?, reviewed_by = ?, reviewed_at = NOW()
         WHERE id = ?`,
        [
          req.body.decision,
          req.body.notes || null,
          req.user.id,
          application.id
        ]
      );
      await recordAudit(connection, {
        actorId: req.user.id,
        action: `VEHICLE_APPLICATION_${req.body.decision}`,
        resourceType: 'vehicle_access_application',
        resourceId: application.id,
        requestId: req.requestId,
        metadata: { reference: application.reference }
      });
      await connection.commit();
      const updated = await findVehicleApplication(db, application.id);
      return res.json({ application: updated });
    } catch (error) {
      await connection.rollback();
      console.error(error);
      return sendError(
        res,
        500,
        'VEHICLE_APPLICATION_DECISION_FAILED',
        'Unable to review vehicle access application.'
      );
    } finally {
      connection.release();
    }
  }
);

router.post(
  '/vehicle-access-applications/:reference/mark-used',
  authenticateToken,
  authorizePermission(PERMISSIONS.USE_VEHICLE_PERMITS),
  validate(schemas.vehicleApplicationMarkUsed),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const application = await findVehicleApplication(
        connection,
        req.params.reference,
        true
      );
      if (!application) {
        await connection.rollback();
        return sendError(res, 404, 'VEHICLE_APPLICATION_NOT_FOUND', 'Application not found.');
      }
      if (application.status !== 'APPROVED') {
        await connection.rollback();
        return sendError(
          res,
          409,
          'INVALID_VEHICLE_APPLICATION_TRANSITION',
          `Permit cannot be marked used from ${application.status}.`
        );
      }
      const [[clock]] = await connection.query(
        'SELECT NOW() BETWEEN ? AND ? AS permit_is_current',
        [application.access_starts_at, application.access_ends_at]
      );
      if (!clock.permit_is_current) {
        await connection.rollback();
        return sendError(
          res,
          409,
          'VEHICLE_PERMIT_OUTSIDE_ACCESS_WINDOW',
          'Permit can only be used during its approved access window.'
        );
      }
      await connection.execute(
        `UPDATE vehicle_access_applications
         SET status = 'USED', used_by = ?, used_at = NOW(3)
         WHERE id = ?`,
        [req.user.id, application.id]
      );
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'VEHICLE_PERMIT_USED',
        resourceType: 'vehicle_access_application',
        resourceId: application.id,
        requestId: req.requestId,
        metadata: { reference: application.reference }
      });
      await connection.commit();
      const updated = await findVehicleApplication(db, application.id);
      return res.json({ application: updated });
    } catch (error) {
      await connection.rollback();
      console.error(error);
      return sendError(
        res,
        500,
        'VEHICLE_PERMIT_USE_FAILED',
        'Unable to mark vehicle permit as used.'
      );
    } finally {
      connection.release();
    }
  }
);

module.exports = router;
