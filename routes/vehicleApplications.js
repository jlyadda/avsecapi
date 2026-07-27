const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authenticateApiKey } = require('../middleware');
const { validate, schemas } = require('../validation');
const { publicApplicationLimiter } = require('../rateLimits');

const router = express.Router();

const normalizeName = (value) => value.toLowerCase().trim().split(/\s+/);

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
           AND ? >= TIMESTAMP(a.visit_starts, '00:00:00')
           AND ? <= DATE_ADD(TIMESTAMP(a.visit_ends, '00:00:00'), INTERVAL 1 DAY)
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

module.exports = router;
