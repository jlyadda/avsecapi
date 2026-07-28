const db = require('./db');
const config = require('./config');
const { sendNotificationEmail } = require('./emailService');

let timer;
let processing = false;

const processNotificationOutbox = async () => {
  if (processing) return false;
  processing = true;
  const connection = await db.getConnection();
  let outbox;
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT outbox.id, outbox.notification_id
       FROM notification_outbox outbox
       INNER JOIN notifications notification
         ON notification.id = outbox.notification_id
       WHERE outbox.status = 'PENDING'
         AND outbox.available_at <= NOW(3)
         AND (notification.scheduled_at IS NULL OR notification.scheduled_at <= NOW(3))
         AND (notification.expires_at IS NULL OR notification.expires_at > NOW(3))
       ORDER BY outbox.available_at
       LIMIT 1 FOR UPDATE`
    );
    outbox = rows[0];
    if (!outbox) {
      await connection.rollback();
      return false;
    }
    await connection.execute(
      `UPDATE notification_outbox
       SET status = 'PROCESSING', attempt_count = attempt_count + 1
       WHERE id = ?`,
      [outbox.id]
    );
    await connection.commit();

    const [deliveries] = await db.execute(
      `SELECT delivery.id, delivery.recipient_email,
              delivery.attempt_count, notification.title, notification.body
       FROM notification_deliveries delivery
       INNER JOIN notifications notification
         ON notification.id = delivery.notification_id
       WHERE delivery.notification_id = ?
         AND delivery.channel = 'EMAIL'
         AND delivery.status = 'PENDING'
         AND delivery.available_at <= NOW(3)`,
      [outbox.notification_id]
    );

    for (const delivery of deliveries) {
      try {
        await sendNotificationEmail({
          email: delivery.recipient_email,
          title: delivery.title,
          body: delivery.body
        });
        await db.execute(
          `UPDATE notification_deliveries
           SET status = 'SENT', attempt_count = attempt_count + 1,
               sent_at = NOW(3), last_error = NULL
           WHERE id = ?`,
          [delivery.id]
        );
      } catch (error) {
        const attempts = delivery.attempt_count + 1;
        const permanent = error.code === 'EAUTH' || attempts >= 5;
        const delayMinutes = Math.min(2 ** attempts, 30);
        await db.execute(
          `UPDATE notification_deliveries
           SET status = ?, attempt_count = ?, last_error = ?,
               available_at = ?
           WHERE id = ?`,
          [
            permanent ? 'FAILED' : 'PENDING',
            attempts,
            String(error.code || error.message).slice(0, 500),
            new Date(Date.now() + delayMinutes * 60 * 1000),
            delivery.id
          ]
        );
      }
    }

    const [[remaining]] = await db.execute(
      `SELECT
         SUM(status = 'PENDING') AS pending,
         SUM(status = 'FAILED') AS failed
       FROM notification_deliveries
       WHERE notification_id = ? AND channel = 'EMAIL'`,
      [outbox.notification_id]
    );
    if (Number(remaining.pending) > 0) {
      const [[nextDelivery]] = await db.execute(
        `SELECT MIN(available_at) AS available_at
         FROM notification_deliveries
         WHERE notification_id = ? AND channel = 'EMAIL' AND status = 'PENDING'`,
        [outbox.notification_id]
      );
      await db.execute(
        `UPDATE notification_outbox
         SET status = 'PENDING', available_at = ?, last_error = NULL
         WHERE id = ?`,
        [nextDelivery.available_at, outbox.id]
      );
    } else {
      await db.execute(
        `UPDATE notification_outbox
         SET status = ?, processed_at = NOW(3),
             last_error = CASE WHEN ? > 0 THEN 'One or more deliveries failed.' ELSE NULL END
         WHERE id = ?`,
        [Number(remaining.failed) > 0 ? 'FAILED' : 'COMPLETED', remaining.failed, outbox.id]
      );
    }
    return true;
  } catch (error) {
    await connection.rollback().catch(() => {});
    if (outbox) {
      await db.execute(
        `UPDATE notification_outbox
         SET status = 'FAILED', last_error = ?, available_at = DATE_ADD(NOW(3), INTERVAL 5 MINUTE)
         WHERE id = ?`,
        [String(error.code || error.message).slice(0, 500), outbox.id]
      );
    }
    console.error('Notification worker failed:', error.message);
    return false;
  } finally {
    connection.release();
    processing = false;
  }
};

const startNotificationWorker = () => {
  if (timer) return;
  timer = setInterval(() => {
    processNotificationOutbox().catch((error) => {
      console.error('Notification worker interval failed:', error.message);
    });
  }, config.NOTIFICATION_WORKER_INTERVAL_MS);
  timer.unref();
  processNotificationOutbox().catch((error) => {
    console.error('Initial notification worker run failed:', error.message);
  });
};

const stopNotificationWorker = () => {
  if (timer) clearInterval(timer);
  timer = undefined;
};

module.exports = {
  processNotificationOutbox,
  startNotificationWorker,
  stopNotificationWorker
};
