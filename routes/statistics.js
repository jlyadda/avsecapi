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
  authorizePermission(PERMISSIONS.VIEW_ADMIN_STATS),
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

module.exports = router;
