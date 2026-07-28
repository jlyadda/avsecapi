const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const app = require('../app');
const config = require('../config');
const db = require('../db');

test.after(() => db.end());

const createSessionToken = async (userId) => {
  const jti = uuidv4();
  await db.execute(
    'INSERT INTO auth_tokens (jti, user_id, expires_at) VALUES (?, ?, ?)',
    [jti, userId, new Date(Date.now() + 300000)]
  );
  return jwt.sign({ id: userId }, config.JWT_SECRET, {
    algorithm: 'HS256',
    audience: 'avsec-clients',
    issuer: 'avsecapi',
    jwtid: jti,
    expiresIn: 300
  });
};

test('remaining internal operations are authenticated, audited and paginated', async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const adminId = uuidv4();
  const vehicleApplicationId = uuidv4();
  const visitorApplicationId = uuidv4();
  const cardId = uuidv4();
  const assignmentId = uuidv4();
  const createdUserName = `created.${uuidv4().slice(0, 8)}`;
  let createdUserId;
  let visitorId;

  try {
    await db.execute(
      `INSERT INTO user_profiles
       (id, user_name, email, password_hash, full_name, user_role, is_active)
       VALUES (?, ?, ?, ?, 'Operations Admin', 'admin', 1)`,
      [
        adminId,
        `gaps.admin.${adminId.slice(0, 8)}`,
        `${adminId}@example.test`,
        await bcrypt.hash('AdminPassword12!', 12)
      ]
    );
    const token = await createSessionToken(adminId);
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    };
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    const ready = await fetch(`${baseUrl}/ready`);
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).database, 'ok');
    assert.ok(ready.headers.get('x-request-id'));

    const anonymousRegister = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal(anonymousRegister.status, 401);
    assert.equal((await anonymousRegister.json()).code, 'AUTH_TOKEN_REQUIRED');

    const createdUserResponse = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        user_name: createdUserName,
        email: `${createdUserName}@example.test`,
        password: 'CreatedPassword12!',
        full_name: 'Created System User',
        role: 'security_assistant',
        is_active: true
      })
    });
    assert.equal(createdUserResponse.status, 201);
    createdUserId = (await createdUserResponse.json()).user.id;

    const identityNumber = `GAPS${Date.now()}`;
    const [visitorResult] = await db.execute(
      `INSERT INTO avsec_visitors
       (first_name, last_name, identity_type, identity_number, issuing_country,
        date_of_birth, gender, security_status, created_by)
       VALUES ('Vehicle', 'Driver', 'NATIONAL_ID', ?, 'UGANDA',
               '1990-01-01', 1, 'ACTIVE', ?)`,
      [identityNumber, adminId]
    );
    visitorId = visitorResult.insertId;
    const [[clock]] = await db.query(
      `SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today,
              DATE_FORMAT(CURTIME(), '%H:%i:%s') AS access_time`
    );

    await db.execute(
      `INSERT INTO visitor_applications
       (id, application_number, visitor_id, personal_email, personal_phone,
        company_name, areas_of_access, supporting_documents, visit_reasons,
        visit_starts, visit_ends, source_key_hash, status)
       VALUES (?, ?, ?, 'driver@example.test', '+256700000099',
               'Vehicle Operations Ltd', '[]', '{}', '[\"Vehicle operations\"]',
               ?, ?, 'INTERNAL_TEST', 'APPROVED')`,
      [
        visitorApplicationId,
        `AVSEC-TEST-${visitorApplicationId.slice(0, 8)}`,
        visitorId,
        clock.today,
        clock.today
      ]
    );
    await db.execute(
      `INSERT INTO vehicle_access_applications
       (id, reference, driver_visitor_id, driver_name, vehicle_registration_number,
        vehicle_type, company, reason_for_access, access_gate, date_of_access,
        time_of_access, duration_of_access_hours, access_starts_at, access_ends_at,
        application_date, source_key_hash)
       VALUES (?, ?, ?, 'Vehicle Driver', ?, 'Service van', 'Vehicle Operations Ltd',
               'Operational endpoint verification', 'Main Gate', ?, ?, 2,
               DATE_SUB(NOW(), INTERVAL 1 HOUR), DATE_ADD(NOW(), INTERVAL 1 HOUR),
               ?, 'INTERNAL_TEST')`,
      [
        vehicleApplicationId,
        `VAP-${vehicleApplicationId.slice(0, 8).toUpperCase()}`,
        visitorId,
        `U${vehicleApplicationId.slice(0, 7).toUpperCase()}`,
        clock.today,
        clock.access_time,
        clock.today
      ]
    );

    const vehicleList = await fetch(
      `${baseUrl}/api/vehicle-access-applications?search=Vehicle%20Driver&page=1&page_size=10`,
      { headers }
    );
    assert.equal(vehicleList.status, 200);
    assert.equal((await vehicleList.json()).pagination.total, 1);

    const vehicleDetail = await fetch(
      `${baseUrl}/api/vehicle-access-applications/${vehicleApplicationId}`,
      { headers }
    );
    assert.equal(vehicleDetail.status, 200);

    const decision = await fetch(
      `${baseUrl}/api/vehicle-access-applications/${vehicleApplicationId}/decision`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ decision: 'APPROVED', notes: 'Verified.' })
      }
    );
    assert.equal(decision.status, 200);

    const markedUsed = await fetch(
      `${baseUrl}/api/vehicle-access-applications/${vehicleApplicationId}/mark-used`,
      { method: 'POST', headers, body: '{}' }
    );
    assert.equal(markedUsed.status, 200);
    assert.equal((await markedUsed.json()).application.status, 'USED');

    await db.execute(
      `INSERT INTO access_cards
       (id, number, access_level, category, is_assigned, is_available, is_returned)
       VALUES (?, ?, 'LEVEL_1', 'VISITOR', 0, 1, 1)`,
      [cardId, `HIST${cardId.slice(0, 8).toUpperCase()}`]
    );
    await db.execute(
      `INSERT INTO card_assignments
       (id, card_id, application_id, assigned_by, assigned_at, status)
       VALUES (?, ?, ?, ?, DATE_SUB(NOW(), INTERVAL 2 HOUR), 'ACTIVE')`,
      [assignmentId, cardId, visitorApplicationId, adminId]
    );
    await db.execute(
      `INSERT INTO card_events
       (id, card_id, event_type, performed_by, created_at)
       VALUES (?, ?, 'CREATED', ?, DATE_SUB(NOW(), INTERVAL 3 HOUR)),
              (?, ?, 'ASSIGNED', ?, DATE_SUB(NOW(), INTERVAL 2 HOUR))`,
      [
        uuidv4(), cardId, adminId,
        uuidv4(), cardId, adminId
      ]
    );

    const history = await fetch(
      `${baseUrl}/api/access-cards/${cardId}/assignments?page=1&page_size=10`,
      { headers }
    );
    assert.equal(history.status, 200);
    assert.equal((await history.json()).assignments[0].id, assignmentId);

    const reconciliation = await fetch(
      `${baseUrl}/api/reconciliation/cards?date=${clock.today}&page=1&page_size=10`,
      { headers }
    );
    assert.equal(reconciliation.status, 200);
    const snapshot = await reconciliation.json();
    assert.equal(snapshot.cards.some((card) => card.id === cardId), true);
    const assignedCard = snapshot.cards.find((card) => card.id === cardId);
    assert.equal(assignedCard.status, 'ASSIGNED');
    assert.equal(assignedCard.holder_name, 'Vehicle Driver');
    assert.equal(assignedCard.holder_phone, '+256700000099');

    const auditEvents = await fetch(
      `${baseUrl}/api/audit-events?action=VEHICLE_PERMIT_USED&resource_id=${vehicleApplicationId}`,
      { headers }
    );
    assert.equal(auditEvents.status, 200);
    const auditBody = await auditEvents.json();
    assert.equal(auditBody.events.length, 1);
    assert.ok(auditBody.events[0].request_id);
  } finally {
    await db.execute(
      `DELETE FROM audit_events
       WHERE actor_id = ?
          OR resource_id IN (?, ?, ?, ?)`,
      [
        adminId,
        vehicleApplicationId,
        visitorApplicationId,
        cardId,
        createdUserId || ''
      ]
    );
    await db.execute('DELETE FROM card_events WHERE card_id = ?', [cardId]);
    await db.execute('DELETE FROM card_assignments WHERE card_id = ?', [cardId]);
    await db.execute('DELETE FROM access_cards WHERE id = ?', [cardId]);
    await db.execute(
      'DELETE FROM vehicle_access_applications WHERE id = ?',
      [vehicleApplicationId]
    );
    await db.execute(
      'DELETE FROM visitor_applications WHERE id = ?',
      [visitorApplicationId]
    );
    if (visitorId) {
      await db.execute('DELETE FROM avsec_visitors WHERE id = ?', [visitorId]);
    }
    await db.execute('DELETE FROM auth_tokens WHERE user_id = ?', [adminId]);
    if (createdUserId) {
      await db.execute('DELETE FROM user_profiles WHERE id = ?', [createdUserId]);
    }
    await db.execute('DELETE FROM user_profiles WHERE id = ?', [adminId]);
    await new Promise((resolve) => server.close(resolve));
  }
});
