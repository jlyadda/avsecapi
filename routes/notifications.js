const express = require('express');
const db = require('../db');
const { authenticateToken, authorizePermission } = require('../middleware');
const { PERMISSIONS } = require('../permissions');
const { validate, schemas } = require('../validation');
const { createNotification } = require('../services/notificationService');
const { recordAudit, sendError } = require('../audit');

const router = express.Router();

const parseJson = (value, fallback) => {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

router.get(
  '/notifications',
  authenticateToken,
  validate(schemas.notificationList),
  async (req, res) => {
    try {
      const { unread, priority, page, page_size } = req.validatedQuery;
      const conditions = [
        'recipient.user_id = ?',
        'recipient.archived_at IS NULL',
        '(notification.scheduled_at IS NULL OR notification.scheduled_at <= NOW(3))',
        '(notification.expires_at IS NULL OR notification.expires_at > NOW(3))'
      ];
      const parameters = [req.user.id];
      if (unread !== undefined) {
        conditions.push(unread ? 'recipient.read_at IS NULL' : 'recipient.read_at IS NOT NULL');
      }
      if (priority) {
        conditions.push('notification.priority = ?');
        parameters.push(priority);
      }
      const whereClause = `WHERE ${conditions.join(' AND ')}`;
      const [[countRow]] = await db.execute(
        `SELECT COUNT(*) AS total
         FROM notification_recipients recipient
         INNER JOIN notifications notification
           ON notification.id = recipient.notification_id
         ${whereClause}`,
        parameters
      );
      const total = Number(countRow.total);
      const [notifications] = await db.execute(
        `SELECT notification.id, notification.type, notification.title,
                notification.body, notification.priority, notification.source,
                notification.resource_type, notification.resource_id,
                notification.metadata, notification.created_at AS occurred_at,
                notification.expires_at, recipient.read_at
         FROM notification_recipients recipient
         INNER JOIN notifications notification
           ON notification.id = recipient.notification_id
         ${whereClause}
         ORDER BY notification.created_at DESC
         LIMIT ? OFFSET ?`,
        [...parameters, page_size, (page - 1) * page_size]
      );
      return res.json({
        notifications,
        pagination: {
          page,
          page_size,
          total,
          total_pages: Math.ceil(total / page_size)
        }
      });
    } catch (error) {
      console.error(error);
      return sendError(res, 500, 'NOTIFICATION_LIST_FAILED', 'Unable to load notifications.');
    }
  }
);

router.get('/notifications/unread-count', authenticateToken, async (req, res) => {
  try {
    const [[row]] = await db.execute(
      `SELECT COUNT(*) AS unread
       FROM notification_recipients recipient
       INNER JOIN notifications notification
         ON notification.id = recipient.notification_id
       WHERE recipient.user_id = ?
         AND recipient.read_at IS NULL
         AND recipient.archived_at IS NULL
         AND (notification.scheduled_at IS NULL OR notification.scheduled_at <= NOW(3))
         AND (notification.expires_at IS NULL OR notification.expires_at > NOW(3))`,
      [req.user.id]
    );
    return res.json({ unread: Number(row.unread) });
  } catch (error) {
    console.error(error);
    return sendError(
      res,
      500,
      'NOTIFICATION_COUNT_FAILED',
      'Unable to load unread notification count.'
    );
  }
});

router.get(
  '/notifications/sent',
  authenticateToken,
  authorizePermission(PERMISSIONS.SEND_NOTIFICATIONS),
  validate(schemas.notificationSentList),
  async (req, res) => {
    try {
      const { search, page, page_size } = req.validatedQuery;
      const conditions = ["notification.source = 'USER'"];
      const parameters = [];
      if (req.user.role !== 'super_admin') {
        conditions.push('notification.actor_id = ?');
        parameters.push(req.user.id);
      }
      if (search) {
        const value = `%${search}%`;
        conditions.push(`(
          notification.title LIKE ? OR notification.body LIKE ? OR notification.type LIKE ?
        )`);
        parameters.push(value, value, value);
      }
      const where = `WHERE ${conditions.join(' AND ')}`;
      const [[countRow]] = await db.execute(
        `SELECT COUNT(*) AS total FROM notifications notification ${where}`,
        parameters
      );
      const total = Number(countRow.total);
      const [broadcasts] = await db.execute(
        `SELECT notification.id, notification.type, notification.title,
                notification.body, notification.priority, notification.channels,
                notification.metadata, notification.scheduled_at,
                notification.expires_at, notification.created_at,
                notification.actor_id AS created_by_id,
                COALESCE(user.full_name, user.user_name) AS created_by,
                (SELECT COUNT(*) FROM notification_recipients recipient
                 WHERE recipient.notification_id = notification.id) AS recipient_count
         FROM notifications notification
         LEFT JOIN user_profiles user ON user.id = notification.actor_id
         ${where}
         ORDER BY notification.created_at DESC
         LIMIT ? OFFSET ?`,
        [...parameters, page_size, (page - 1) * page_size]
      );
      const ids = broadcasts.map((broadcast) => broadcast.id);
      let targets = [];
      let deliveryRows = [];
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(', ');
        [targets] = await db.query(
          `SELECT notification_id, target_type, target_value
           FROM notification_targets
           WHERE notification_id IN (${placeholders})
           ORDER BY notification_id, target_type, target_value`,
          ids
        );
        [deliveryRows] = await db.query(
          `SELECT notification_id, channel, status, COUNT(*) AS total
           FROM notification_deliveries
           WHERE notification_id IN (${placeholders})
           GROUP BY notification_id, channel, status
           ORDER BY notification_id, channel, status`,
          ids
        );
      }
      return res.json({
        broadcasts: broadcasts.map((broadcast) => {
          const deliveryTotals = {};
          for (const delivery of deliveryRows.filter(
            (row) => row.notification_id === broadcast.id
          )) {
            if (!deliveryTotals[delivery.channel]) {
              deliveryTotals[delivery.channel] = { total: 0 };
            }
            const count = Number(delivery.total);
            deliveryTotals[delivery.channel][delivery.status.toLowerCase()] = count;
            deliveryTotals[delivery.channel].total += count;
          }
          return {
            ...broadcast,
            channels: parseJson(broadcast.channels, []),
            metadata: parseJson(broadcast.metadata, {}),
            recipient_count: Number(broadcast.recipient_count),
            targets: targets.filter((target) => target.notification_id === broadcast.id)
              .map((target) => ({
                type: target.target_type,
                value: target.target_value
              })),
            delivery_totals: deliveryTotals
          };
        }),
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
        'SENT_NOTIFICATION_LIST_FAILED',
        'Unable to load sent broadcasts.'
      );
    }
  }
);

router.post(
  '/notifications',
  authenticateToken,
  authorizePermission(PERMISSIONS.SEND_NOTIFICATIONS),
  validate(schemas.notificationCreate),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const notification = await createNotification(connection, {
        source: 'USER',
        type: req.body.type,
        title: req.body.title,
        body: req.body.body,
        priority: req.body.priority,
        actorId: req.user.id,
        requestId: req.requestId,
        channels: req.body.channels,
        targets: req.body.targets,
        scheduledAt: req.body.scheduled_at || null,
        expiresAt: req.body.expires_at || null,
        excludedRoles: req.user.role === 'admin' ? ['super_admin'] : []
      });
      if (notification.recipientCount === 0) {
        await connection.rollback();
        return sendError(
          res,
          422,
          'NOTIFICATION_HAS_NO_RECIPIENTS',
          'No active users matched the selected audience.'
        );
      }
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'NOTIFICATION_CREATED',
        resourceType: 'notification',
        resourceId: notification.id,
        requestId: req.requestId,
        metadata: {
          recipient_count: notification.recipientCount,
          channels: req.body.channels
        }
      });
      await connection.commit();
      return res.status(201).json({ notification });
    } catch (error) {
      await connection.rollback();
      console.error(error);
      return sendError(res, 500, 'NOTIFICATION_CREATE_FAILED', 'Unable to create notification.');
    } finally {
      connection.release();
    }
  }
);

router.patch(
  '/notifications/:id/read',
  authenticateToken,
  validate(schemas.notificationId),
  async (req, res) => {
    try {
      const [result] = await db.execute(
        `UPDATE notification_recipients
         SET read_at = COALESCE(read_at, NOW(3))
         WHERE notification_id = ? AND user_id = ?`,
        [req.params.id, req.user.id]
      );
      if (result.affectedRows === 0) {
        return sendError(res, 404, 'NOTIFICATION_NOT_FOUND', 'Notification not found.');
      }
      return res.json({ message: 'Notification marked as read.' });
    } catch (error) {
      console.error(error);
      return sendError(res, 500, 'NOTIFICATION_READ_FAILED', 'Unable to mark notification read.');
    }
  }
);

router.post(
  '/notifications/read-all',
  authenticateToken,
  validate(schemas.notificationReadAll),
  async (req, res) => {
    try {
      const [result] = await db.execute(
        `UPDATE notification_recipients
         SET read_at = NOW(3)
         WHERE user_id = ? AND read_at IS NULL`,
        [req.user.id]
      );
      return res.json({ message: 'Notifications marked as read.', updated: result.affectedRows });
    } catch (error) {
      console.error(error);
      return sendError(res, 500, 'NOTIFICATION_READ_ALL_FAILED', 'Unable to update notifications.');
    }
  }
);

router.patch(
  '/notifications/:id/archive',
  authenticateToken,
  validate(schemas.notificationId),
  async (req, res) => {
    try {
      const [result] = await db.execute(
        `UPDATE notification_recipients
         SET archived_at = COALESCE(archived_at, NOW(3))
         WHERE notification_id = ? AND user_id = ?`,
        [req.params.id, req.user.id]
      );
      if (result.affectedRows === 0) {
        return sendError(res, 404, 'NOTIFICATION_NOT_FOUND', 'Notification not found.');
      }
      return res.json({ message: 'Notification archived.' });
    } catch (error) {
      console.error(error);
      return sendError(res, 500, 'NOTIFICATION_ARCHIVE_FAILED', 'Unable to archive notification.');
    }
  }
);

router.get(
  '/notifications/:id/deliveries',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_NOTIFICATION_DELIVERIES),
  validate(schemas.notificationDeliveryList),
  async (req, res) => {
    try {
      const { page, page_size } = req.validatedQuery;
      const [[countRow]] = await db.execute(
        'SELECT COUNT(*) AS total FROM notification_deliveries WHERE notification_id = ?',
        [req.params.id]
      );
      const total = Number(countRow.total);
      const [deliveries] = await db.execute(
        `SELECT delivery.id, delivery.user_id, user.user_name,
                delivery.recipient_email, delivery.recipient_phone,
                delivery.channel, delivery.status, delivery.attempt_count,
                delivery.provider_message_id, delivery.sent_at, delivery.created_at
         FROM notification_deliveries delivery
         LEFT JOIN user_profiles user ON user.id = delivery.user_id
         WHERE delivery.notification_id = ?
         ORDER BY delivery.created_at
         LIMIT ? OFFSET ?`,
        [req.params.id, page_size, (page - 1) * page_size]
      );
      return res.json({
        deliveries,
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
        'NOTIFICATION_DELIVERY_LIST_FAILED',
        'Unable to load notification deliveries.'
      );
    }
  }
);

module.exports = router;
