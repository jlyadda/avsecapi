const db = require('../db');
const config = require('../config');

let timer;
let processing = false;

const synchronizeActiveVisitors = async () => {
  if (processing) return 0;
  processing = true;
  const connection = await db.getConnection();
  let lockAcquired = false;
  try {
    const [[lock]] = await connection.query(
      "SELECT GET_LOCK('avsec:visitor-lifecycle', 0) AS acquired"
    );
    lockAcquired = Number(lock.acquired) === 1;
    if (!lockAcquired) return 0;
    await connection.beginTransaction();
    await connection.execute(
      `UPDATE visitors visitor
       INNER JOIN all_visitors profile ON profile.id = visitor.all_visitor_id
       INNER JOIN visitor_applications application
         ON application.id = visitor.application_id
       SET visitor.full_name = CONCAT_WS(
             ' ', profile.first_name, profile.other_names, profile.last_name
           ),
           visitor.company = application.company_name,
           visitor.email = application.personal_email,
           visitor.phone = application.personal_phone,
           visitor.approved_areas_of_access = COALESCE((
             SELECT CONCAT(
               '[',
               GROUP_CONCAT(JSON_QUOTE(approved.area_code)
                 ORDER BY approved.area_code SEPARATOR ','),
               ']'
             )
             FROM application_approved_access_areas approved
             WHERE approved.application_id = application.id
           ), JSON_ARRAY()),
           visitor.visit_reasons = application.visit_reasons,
           visitor.areas_of_access = COALESCE(application.areas_of_access, JSON_ARRAY()),
           visitor.valid_from = application.approved_visit_starts,
           visitor.valid_until = application.approved_visit_ends,
           visitor.status = CASE
             WHEN EXISTS (
               SELECT 1 FROM card_assignments assignment
               WHERE assignment.application_id = visitor.application_id
                 AND assignment.status = 'ACTIVE'
             ) THEN 'CHECKED_IN'
             WHEN application.approved_visit_starts > CURDATE() THEN 'PENDING_VALIDITY'
             WHEN visitor.status = 'CHECKED_OUT' THEN 'CHECKED_OUT'
             ELSE 'ELIGIBLE'
           END
       WHERE application.approved_visit_starts IS NOT NULL
         AND application.approved_visit_ends IS NOT NULL`
    );
    await connection.execute(
      `UPDATE visitors
       SET status = 'ELIGIBLE'
       WHERE status = 'PENDING_VALIDITY'
         AND valid_from <= CURDATE()
         AND valid_until >= CURDATE()`
    );
    const [expired] = await connection.execute(
      `SELECT visitor.id, visitor.application_id, visitor.valid_until,
              EXISTS (
                SELECT 1 FROM card_assignments assignment
                WHERE assignment.application_id = visitor.application_id
                  AND assignment.status = 'ACTIVE'
              ) AS has_active_pass
       FROM visitors visitor
       WHERE visitor.valid_until < CURDATE()
       FOR UPDATE`
    );
    for (const visitor of expired) {
      await connection.execute(
        `INSERT INTO audit_events
         (id, actor_id, action, resource_type, resource_id, request_id, metadata)
         VALUES (UUID(), NULL, 'ACTIVE_VISITOR_EXPIRED', 'visitor', ?, UUID(), ?)`,
        [
          visitor.id,
          JSON.stringify({
            application_id: visitor.application_id,
            valid_until: visitor.valid_until,
            active_pass_pending_return: Boolean(visitor.has_active_pass)
          })
        ]
      );
    }
    const [result] = await connection.execute(
      'DELETE FROM visitors WHERE valid_until < CURDATE()'
    );
    await connection.commit();
    return result.affectedRows;
  } catch (error) {
    await connection.rollback();
    console.error('Visitor lifecycle cleanup failed:', error.message);
    return 0;
  } finally {
    if (lockAcquired) {
      try {
        await connection.query("SELECT RELEASE_LOCK('avsec:visitor-lifecycle')");
      } catch (error) {
        console.error('Visitor lifecycle lock release failed:', error.message);
      }
    }
    connection.release();
    processing = false;
  }
};

const startVisitorLifecycleWorker = () => {
  if (timer) return;
  timer = setInterval(() => {
    synchronizeActiveVisitors().catch((error) => {
      console.error('Visitor lifecycle interval failed:', error.message);
    });
  }, config.VISITOR_LIFECYCLE_INTERVAL_MS);
  timer.unref();
  synchronizeActiveVisitors().catch((error) => {
    console.error('Initial visitor lifecycle cleanup failed:', error.message);
  });
};

const stopVisitorLifecycleWorker = () => {
  if (timer) clearInterval(timer);
  timer = undefined;
};

module.exports = {
  removeExpiredVisitors: synchronizeActiveVisitors,
  synchronizeActiveVisitors,
  startVisitorLifecycleWorker,
  stopVisitorLifecycleWorker
};
