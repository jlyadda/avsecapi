const express = require('express');
const db = require('../db');
const config = require('../config');
const { authenticateToken, authorizePermission } = require('../middleware');
const { PERMISSIONS } = require('../permissions');
const { validate, schemas } = require('../validation');
const { sendError } = require('../audit');

const router = express.Router();

const formatDate = (date) => date.toISOString().slice(0, 10);

const firstBucket = (from, interval) => {
  const date = new Date(`${from}T00:00:00Z`);
  if (interval === 'week') {
    const mondayOffset = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - mondayOffset);
  } else if (interval === 'month') {
    date.setUTCDate(1);
  }
  return date;
};

const nextBucket = (date, interval) => {
  const next = new Date(date);
  if (interval === 'day') next.setUTCDate(next.getUTCDate() + 1);
  if (interval === 'week') next.setUTCDate(next.getUTCDate() + 7);
  if (interval === 'month') next.setUTCMonth(next.getUTCMonth() + 1, 1);
  return next;
};

router.get(
  '/statistics/pass-assignments',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_PASS_STATISTICS),
  validate(schemas.passAssignmentStatistics),
  async (req, res) => {
    try {
      const { from, to, interval } = req.validatedQuery;
      const bucketExpression = {
        day: "DATE_FORMAT(local_created_at, '%Y-%m-%d')",
        week: `DATE_FORMAT(
          DATE_SUB(DATE(local_created_at), INTERVAL WEEKDAY(local_created_at) DAY),
          '%Y-%m-%d'
        )`,
        month: "DATE_FORMAT(local_created_at, '%Y-%m-01')"
      }[interval];
      const [rows] = await db.execute(
        `SELECT ${bucketExpression} AS bucket,
                SUM(event_type = 'ASSIGNED') AS assigned,
                SUM(event_type = 'RETURNED') AS returned
         FROM (
           SELECT event_type,
                  CONVERT_TZ(created_at, @@session.time_zone, ?) AS local_created_at
           FROM card_events
           WHERE event_type IN ('ASSIGNED','RETURNED')
         ) event
         WHERE local_created_at >= CONCAT(?, ' 00:00:00')
           AND local_created_at < DATE_ADD(CONCAT(?, ' 00:00:00'), INTERVAL 1 DAY)
         GROUP BY bucket
         ORDER BY bucket`,
        [config.AIRPORT_UTC_OFFSET, from, to]
      );
      const values = new Map(rows.map((row) => [row.bucket, {
        assigned: Number(row.assigned),
        returned: Number(row.returned)
      }]));
      const points = [];
      const end = new Date(`${to}T00:00:00Z`);
      for (
        let bucket = firstBucket(from, interval);
        bucket <= end;
        bucket = nextBucket(bucket, interval)
      ) {
        const date = formatDate(bucket);
        const value = values.get(date) || { assigned: 0, returned: 0 };
        points.push({ date, ...value });
      }
      return res.json({
        points,
        totals: points.reduce((totals, point) => ({
          assigned: totals.assigned + point.assigned,
          returned: totals.returned + point.returned
        }), { assigned: 0, returned: 0 }),
        range: {
          from,
          to,
          interval,
          timezone_offset: config.AIRPORT_UTC_OFFSET
        }
      });
    } catch (error) {
      console.error(error);
      return sendError(
        res,
        500,
        'PASS_ASSIGNMENT_STATISTICS_FAILED',
        'Unable to load pass assignment statistics.'
      );
    }
  }
);

router.get(
  '/statistics/applicants-by-nationality',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_APPLICANT_STATISTICS),
  validate(schemas.applicantNationalityStatistics),
  async (req, res) => {
    try {
      const { from, to } = req.validatedQuery;
      const [nationalities] = await db.execute(
        `SELECT COALESCE(NULLIF(TRIM(profile.issuing_country), ''), 'UNSPECIFIED')
                  AS nationality,
                COUNT(DISTINCT profile.id) AS applicants,
                COUNT(*) AS applications
         FROM visitor_applications application
         INNER JOIN all_visitors profile ON profile.id = application.visitor_id
         WHERE CONVERT_TZ(application.created_at, @@session.time_zone, ?)
                 >= CONCAT(?, ' 00:00:00')
           AND CONVERT_TZ(application.created_at, @@session.time_zone, ?)
                 < DATE_ADD(CONCAT(?, ' 00:00:00'), INTERVAL 1 DAY)
         GROUP BY nationality
         ORDER BY applicants DESC, applications DESC, nationality`,
        [config.AIRPORT_UTC_OFFSET, from, config.AIRPORT_UTC_OFFSET, to]
      );
      const values = nationalities.map((item) => ({
        nationality: item.nationality,
        applicants: Number(item.applicants),
        applications: Number(item.applications)
      }));
      return res.json({
        nationalities: values,
        totals: values.reduce((totals, item) => ({
          applicants: totals.applicants + item.applicants,
          applications: totals.applications + item.applications
        }), { applicants: 0, applications: 0 }),
        range: {
          from,
          to,
          date_basis: 'application_created_at',
          timezone_offset: config.AIRPORT_UTC_OFFSET
        }
      });
    } catch (error) {
      console.error(error);
      return sendError(
        res,
        500,
        'APPLICANT_NATIONALITY_STATISTICS_FAILED',
        'Unable to load applicant nationality statistics.'
      );
    }
  }
);

router.get(
  '/statistics/repeat-visitors',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_APPLICANT_STATISTICS),
  validate(schemas.repeatVisitorStatistics),
  async (req, res) => {
    try {
      const { from, to, limit } = req.validatedQuery;
      const [visitors] = await db.execute(
        `SELECT profile.id AS all_visitor_id,
                CONCAT_WS(' ', profile.first_name, profile.other_names, profile.last_name)
                  AS full_name,
                profile.company,
                profile.issuing_country AS nationality,
                COUNT(*) AS times_visited,
                COUNT(DISTINCT DATE(CONVERT_TZ(visit_session.checked_in_at,
                  @@session.time_zone, ?))) AS visit_days,
                MAX(CONVERT_TZ(visit_session.checked_in_at, @@session.time_zone, ?))
                  AS last_visited_at
         FROM visit_sessions visit_session
         INNER JOIN all_visitors profile ON profile.id = visit_session.visitor_id
         WHERE CONVERT_TZ(visit_session.checked_in_at, @@session.time_zone, ?)
                 >= CONCAT(?, ' 00:00:00')
           AND CONVERT_TZ(visit_session.checked_in_at, @@session.time_zone, ?)
                 < DATE_ADD(CONCAT(?, ' 00:00:00'), INTERVAL 1 DAY)
         GROUP BY profile.id
         HAVING COUNT(*) >= 2
         ORDER BY times_visited DESC, last_visited_at DESC, full_name
         LIMIT ?`,
        [
          config.AIRPORT_UTC_OFFSET,
          config.AIRPORT_UTC_OFFSET,
          config.AIRPORT_UTC_OFFSET,
          from,
          config.AIRPORT_UTC_OFFSET,
          to,
          limit
        ]
      );
      return res.json({
        visitors: visitors.map((visitor) => ({
          ...visitor,
          times_visited: Number(visitor.times_visited),
          visit_days: Number(visitor.visit_days)
        })),
        range: {
          from,
          to,
          date_basis: 'checked_in_at',
          timezone_offset: config.AIRPORT_UTC_OFFSET
        },
        limit
      });
    } catch (error) {
      console.error(error);
      return sendError(
        res,
        500,
        'REPEAT_VISITOR_STATISTICS_FAILED',
        'Unable to load repeat visitor statistics.'
      );
    }
  }
);

module.exports = router;
