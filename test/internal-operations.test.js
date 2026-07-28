const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const app = require('../app');
const config = require('../config');
const db = require('../db');

test.after(() => db.end());

const listen = async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
};

const close = (server) => new Promise((resolve) => server.close(resolve));

const createSessionToken = async (userId) => {
  const jti = uuidv4();
  await db.execute(
    'INSERT INTO auth_tokens (jti, user_id, expires_at) VALUES (?, ?, ?)',
    [jti, userId, new Date(Date.now() + 300000)]
  );
  const token = jwt.sign({ id: userId }, config.JWT_SECRET, {
    algorithm: 'HS256',
    audience: 'avsec-clients',
    issuer: 'avsecapi',
    jwtid: jti,
    expiresIn: 300
  });
  return { jti, token };
};

test('internal application, card, account, user list and refresh workflows', async () => {
  const server = await listen();
  const adminId = uuidv4();
  const assistantId = uuidv4();
  let cardId;
  const identityNumber = `OPS${Date.now()}`;
  const password = 'InitialPassword12!';
  let applicationId;

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    await db.execute(
      `INSERT INTO user_profiles
       (id, user_name, email, password_hash, full_name, department, user_role, is_active)
       VALUES (?, ?, ?, ?, ?, 'Aviation Security', 'admin', 1)`,
      [
        adminId,
        `ops.admin.${adminId.slice(0, 8)}`,
        `${adminId}@example.test`,
        passwordHash,
        'Operations Admin'
      ]
    );
    await db.execute(
      `INSERT INTO user_profiles
       (id, user_name, email, password_hash, full_name, department, user_role, is_active)
       VALUES (?, ?, ?, ?, ?, 'Aviation Security', 'security_assistant', 1)`,
      [
        assistantId,
        `ops.assistant.${assistantId.slice(0, 8)}`,
        `${assistantId}@example.test`,
        passwordHash,
        'Operations Assistant'
      ]
    );
    const adminSession = await createSessionToken(adminId);
    const assistantSession = await createSessionToken(assistantId);
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}/api`;
    const headers = {
      authorization: `Bearer ${adminSession.token}`,
      'content-type': 'application/json'
    };
    const [[databaseClock]] = await db.query(
      "SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today"
    );
    const today = databaseClock.today;

    const created = await fetch(`${baseUrl}/visitor-applications`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        first_name: 'Internal',
        last_name: 'Visitor',
        date_of_birth: '1990-01-01',
        gender: 1,
        identity_type: 'NATIONAL_ID',
        identity_number: identityNumber,
        personal_phone: '+256700000010',
        personal_email: 'internal.visitor@example.test',
        company_name: 'Internal Operations Limited',
        company_position: 'Technician',
        visit_reasons: ['Internal route verification'],
        areas_of_access: ['Terminal'],
        visit_starts: today,
        visit_ends: today
      })
    });
    assert.equal(created.status, 201);
    const createdApplication = (await created.json()).application;
    applicationId = createdApplication.id;
    assert.equal(createdApplication.status, 'SUBMITTED');

    const listed = await fetch(
      `${baseUrl}/visitor-applications?search=${identityNumber}&status=SUBMITTED&page=1&page_size=10`,
      { headers }
    );
    assert.equal(listed.status, 200);
    const applicationList = await listed.json();
    assert.equal(applicationList.applications.length, 1);
    assert.equal(applicationList.pagination.total, 1);

    const users = await fetch(
      `${baseUrl}/users?role=security_assistant&is_active=true&search=Operations%20Assistant`,
      { headers }
    );
    assert.equal(users.status, 200);
    assert.equal((await users.json()).users.some((user) => user.id === assistantId), true);

    const createdCard = await fetch(`${baseUrl}/access-cards`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        number: `OPS${uuidv4().slice(0, 8)}`,
        access_level: 'LEVEL_1',
        category: 'VISITOR'
      })
    });
    assert.equal(createdCard.status, 201);
    const card = (await createdCard.json()).card;
    cardId = card.id;

    const approved = await fetch(
      `${baseUrl}/visitor-applications/${applicationId}/decision`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ decision: 'APPROVED', notes: 'Verified for card test.' })
      }
    );
    assert.equal(approved.status, 200);

    const assigned = await fetch(
      `${baseUrl}/visitor-applications/${applicationId}/card-assignment`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${assistantSession.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ card_number: card.number })
      }
    );
    assert.equal(assigned.status, 200);
    assert.equal((await assigned.json()).application.card_status, 'ASSIGNED');

    const checkedIn = await fetch(
      `${baseUrl}/visitor-applications/${applicationId}/check-in`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${assistantSession.token}`,
          'content-type': 'application/json'
        },
        body: '{}'
      }
    );
    assert.equal(checkedIn.status, 200);

    const blockedCheckout = await fetch(
      `${baseUrl}/visitor-applications/${applicationId}/check-out`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${assistantSession.token}`,
          'content-type': 'application/json'
        },
        body: '{}'
      }
    );
    assert.equal(blockedCheckout.status, 409);

    const returned = await fetch(
      `${baseUrl}/visitor-applications/${applicationId}/card-return`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${assistantSession.token}`,
          'content-type': 'application/json'
        },
        body: '{}'
      }
    );
    assert.equal(returned.status, 200);

    const accountUpdate = await fetch(`${baseUrl}/account`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ full_name: 'Updated Operations Admin' })
    });
    assert.equal(accountUpdate.status, 200);
    assert.equal((await accountUpdate.json()).account.full_name, 'Updated Operations Admin');

    const passwordChange = await fetch(`${baseUrl}/account/password`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        current_password: password,
        new_password: 'ReplacementPassword12!'
      })
    });
    assert.equal(passwordChange.status, 200);

    const refreshed = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers
    });
    assert.equal(refreshed.status, 200);
    const refreshBody = await refreshed.json();
    assert.ok(refreshBody.token);

    const oldTokenRejected = await fetch(`${baseUrl}/account`, { headers });
    assert.equal(oldTokenRejected.status, 403);
    const newTokenAccepted = await fetch(`${baseUrl}/account`, {
      headers: { authorization: `Bearer ${refreshBody.token}` }
    });
    assert.equal(newTokenAccepted.status, 200);
  } finally {
    if (applicationId) {
      await db.execute('DELETE FROM notifications WHERE resource_id = ?', [applicationId]);
    }
    await db.execute(
      `DELETE FROM audit_events
       WHERE actor_id IN (?, ?)
          OR resource_id IN (?, ?)`,
      [adminId, assistantId, applicationId || '', cardId || '']
    );
    if (applicationId) {
      await db.execute('DELETE FROM card_events WHERE application_id = ?', [applicationId]);
      await db.execute('DELETE FROM card_assignments WHERE application_id = ?', [applicationId]);
      await db.execute('DELETE FROM visit_sessions WHERE application_id = ?', [applicationId]);
      await db.execute('DELETE FROM visitor_applications WHERE id = ?', [applicationId]);
    }
    if (cardId) {
      await db.execute('DELETE FROM card_events WHERE card_id = ?', [cardId]);
      await db.execute('DELETE FROM access_cards WHERE id = ?', [cardId]);
    }
    await db.execute('DELETE FROM avsec_visitors WHERE identity_number = ?', [identityNumber]);
    await db.execute('DELETE FROM auth_tokens WHERE user_id IN (?, ?)', [adminId, assistantId]);
    await db.execute('DELETE FROM user_profiles WHERE id IN (?, ?)', [adminId, assistantId]);
    await close(server);
  }
});
