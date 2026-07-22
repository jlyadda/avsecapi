const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const app = require('../app');
const config = require('../config');
const db = require('../db');
const { schemas } = require('../validation');
const { PERMISSIONS, hasPermission, canManageRole } = require('../permissions');

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

test('role permissions enforce application boundaries', () => {
  assert.equal(hasPermission('security_assistant', PERMISSIONS.VIEW_APPLICATIONS), true);
  assert.equal(hasPermission('security_assistant', PERMISSIONS.CHECK_IN_OUT), true);
  assert.equal(hasPermission('security_assistant', PERMISSIONS.REVIEW_APPLICATIONS), false);
  assert.equal(hasPermission('security_assistant', PERMISSIONS.MANAGE_API_KEYS), false);
  assert.equal(hasPermission('supervisor', PERMISSIONS.REVIEW_APPLICATIONS), true);
  assert.equal(hasPermission('supervisor', PERMISSIONS.MANAGE_API_KEYS), false);
  assert.equal(hasPermission('admin', PERMISSIONS.MANAGE_USERS), true);
  assert.equal(hasPermission('admin', PERMISSIONS.MANAGE_API_KEYS), true);
  assert.equal(hasPermission('admin', PERMISSIONS.MANAGE_ROLES), false);
  assert.equal(hasPermission('super_admin', PERMISSIONS.MANAGE_ROLES), true);
  assert.equal(canManageRole('admin', 'security_assistant'), true);
  assert.equal(canManageRole('admin', 'admin'), false);
});

test('registration rejects caller-controlled roles', () => {
  const result = schemas.register.safeParse({
    body: {
      user_name: 'candidate.user',
      email: 'candidate@example.com',
      password: 'StrongPassword12!',
      user_role: 'super_admin'
    }
  });

  assert.equal(result.success, false);
});

test('public application validation normalizes identity and visit data', () => {
  const result = schemas.publicApplication.safeParse({
    body: {
      first_name: 'Visitor',
      last_name: 'Applicant',
      identity_type: 'NIN',
      identity_number: 'cm1234567890',
      date_of_birth: '1990-01-01',
      email: 'VISITOR@EXAMPLE.COM',
      phone: '+256 700 000000',
      purpose: 'Security briefing',
      host_name: 'Host Name',
      host_email: 'HOST@EXAMPLE.COM',
      expected_arrival: '2026-07-22T12:00:00+03:00',
      expected_departure: '2026-07-22T14:00:00+03:00'
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.data.body.identity_number, 'CM1234567890');
  assert.equal(result.data.body.email, 'visitor@example.com');
  assert.equal(result.data.body.expected_arrival instanceof Date, true);
});

test('login rate limiter blocks repeated invalid requests', async () => {
  const server = await listen();
  try {
    const { port } = server.address();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      assert.equal(response.status, 400);
    }

    const blocked = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal(blocked.status, 429);
  } finally {
    await close(server);
  }
});

test('visitor application completes approval, check-in and check-out', async () => {
  const server = await listen();
  const assistantId = uuidv4();
  const adminId = uuidv4();
  const identityNumber = `TEST${Date.now()}`;
  const sessionIds = [];
  let applicationId;
  let externalApiKeyId;

  try {
    await db.execute(
      `INSERT INTO user_profiles
       (id, user_name, email, password_hash, full_name, department, user_role, is_active)
       VALUES (?, ?, ?, ?, ?, 'Aviation Security', 'security_assistant', 1)`,
      [assistantId, `assistant.${assistantId.slice(0, 8)}`, `${assistantId}@example.test`, 'unused', 'Test Assistant']
    );
    await db.execute(
      `INSERT INTO user_profiles
       (id, user_name, email, password_hash, full_name, department, user_role, is_active)
       VALUES (?, ?, ?, ?, ?, 'Aviation Security', 'admin', 1)`,
      [adminId, `admin.${adminId.slice(0, 8)}`, `${adminId}@example.test`, 'unused', 'Test Admin']
    );
    const reviewerSession = await createSessionToken(adminId);
    const assistantSession = await createSessionToken(assistantId);
    sessionIds.push(reviewerSession.jti, assistantSession.jti);

    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}/api`;
    const createdKeyResponse = await fetch(`${baseUrl}/external-api-keys`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${reviewerSession.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: 'Lifecycle public application client',
        purpose: 'Submit temporary applications during automated lifecycle testing.',
        role: 'VISITOR_APPLICATION'
      })
    });
    assert.equal(createdKeyResponse.status, 201);
    const createdKey = await createdKeyResponse.json();
    externalApiKeyId = createdKey.apiKey.id;

    const applicationBody = {
      first_name: 'Lifecycle',
      last_name: 'Visitor',
      identity_type: 'NIN',
      identity_number: identityNumber,
      issuing_country: 'UG',
      date_of_birth: '1990-01-01',
      email: 'lifecycle@example.test',
      phone: '+256700000000',
      purpose: 'Automated lifecycle verification',
      host_name: 'Test Host',
      host_email: 'host@example.test',
      expected_arrival: '2026-07-22T09:00:00+03:00',
      expected_departure: '2026-07-22T12:00:00+03:00'
    };

    const missingKey = await fetch(`${baseUrl}/public/visitor-applications`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(applicationBody)
    });
    assert.equal(missingKey.status, 401);

    const submitted = await fetch(`${baseUrl}/public/visitor-applications`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': createdKey.secret
      },
      body: JSON.stringify(applicationBody)
    });
    assert.equal(submitted.status, 202);
    const submission = await submitted.json();
    applicationId = submission.applicationId;

    const approved = await fetch(`${baseUrl}/visitor-applications/${applicationId}/decision`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${reviewerSession.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ decision: 'APPROVED', notes: 'Identity verified.' })
    });
    assert.equal(approved.status, 200);

    const checkedIn = await fetch(`${baseUrl}/visitor-applications/${applicationId}/check-in`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${assistantSession.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ gate: 'Main Gate' })
    });
    assert.equal(checkedIn.status, 200);

    const checkedOut = await fetch(`${baseUrl}/visitor-applications/${applicationId}/check-out`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${assistantSession.token}`,
        'content-type': 'application/json'
      },
      body: '{}'
    });
    assert.equal(checkedOut.status, 200);

    const details = await fetch(`${baseUrl}/visitor-applications/${applicationId}`, {
      headers: { authorization: `Bearer ${assistantSession.token}` }
    });
    assert.equal(details.status, 200);
    assert.equal((await details.json()).application.status, 'CHECKED_OUT');

    const revoked = await fetch(`${baseUrl}/external-api-keys/${externalApiKeyId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${reviewerSession.token}` }
    });
    assert.equal(revoked.status, 200);

    const blockedAfterRevocation = await fetch(`${baseUrl}/public/visitor-applications`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': createdKey.secret
      },
      body: JSON.stringify(applicationBody)
    });
    assert.equal(blockedAfterRevocation.status, 401);
  } finally {
    if (applicationId) {
      await db.execute('DELETE FROM visit_sessions WHERE application_id = ?', [applicationId]);
      await db.execute('DELETE FROM visitor_applications WHERE id = ?', [applicationId]);
    }
    await db.execute('DELETE FROM avsec_visitors WHERE identity_number = ?', [identityNumber]);
    if (sessionIds.length > 0) {
      await db.query('DELETE FROM auth_tokens WHERE jti IN (?)', [sessionIds]);
    }
    if (externalApiKeyId) {
      await db.execute('DELETE FROM external_api_keys WHERE id = ?', [externalApiKeyId]);
    }
    await db.execute('DELETE FROM user_profiles WHERE id = ?', [assistantId]);
    await db.execute('DELETE FROM user_profiles WHERE id = ?', [adminId]);
    await close(server);
  }
});
