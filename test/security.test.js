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
      personal_data: {
        identity_expiry_date: '19-01-2035',
        first_name: 'Lyadda',
        last_name: 'Jonathan',
        other_names: 'Gift',
        identity_type: 'National ID',
        identity_number: 'cm203601en7tl',
        issuing_country: 'Uganda',
        date_of_birth: '08-08-2002',
        personal_phone: '+256701405780',
        alternative_personal_phone: '+256766099107',
        personal_email: 'JONALYADDA@GMAIL.COM',
        gender: 'true'
      },
      company_details: {
        company_name: 'Kalman Solutions Limited',
        company_position: 'IT Technician',
        company_address: 'Entebbe, Uganda',
        company_phone: '+256700111222',
        company_email: 'operations@kalmansolutions.com'
      },
      visit_data: {
        visit_reason: ['CCTV installation and maintenance', 'LAN installation'],
        areas_of_access: ['Terminal', 'Vip', 'Airside', ''],
        visit_starts: '20-07-2026',
        visit_ends: '29-08-2026'
      },
      supporting_documents: {
        identity_document_url: 'https://files.example.com/id.pdf',
        avsec_endorsed_letter_url: 'https://files.example.com/endorsement.pdf',
        passport_photograph_url: 'https://files.example.com/photo.jpg',
        other_document_urls: ['https://files.example.com/additional.pdf']
      }
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.data.body.identity_number, 'CM203601EN7TL');
  assert.equal(result.data.body.identity_type, 'NATIONAL_ID');
  assert.equal(result.data.body.issuing_country, 'UGANDA');
  assert.equal(result.data.body.date_of_birth, '2002-08-08');
  assert.equal(result.data.body.personal_email, 'jonalyadda@gmail.com');
  assert.equal(result.data.body.gender, true);
  assert.deepEqual(result.data.body.areas_of_access, ['Terminal', 'Vip', 'Airside']);
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
      personal_data: {
        identity_expiry_date: '01-01-2035',
        first_name: 'Lifecycle',
        last_name: 'Visitor',
        identity_type: 'National ID',
        identity_number: identityNumber,
        issuing_country: 'Uganda',
        date_of_birth: '01-01-1990',
        personal_phone: '+256700000000',
        alternative_personal_phone: '+256700000002',
        personal_email: 'lifecycle@example.test',
        gender: 'false'
      },
      company_details: {
        company_name: 'Lifecycle Aviation Ltd',
        company_position: 'Test Engineer',
        company_address: 'Airport Road, Entebbe',
        company_phone: '+256700000001',
        company_email: 'company@example.test'
      },
      visit_data: {
        visit_reason: ['Automated lifecycle verification'],
        areas_of_access: ['Main Terminal', 'Operations Office'],
        visit_starts: '22-07-2026',
        visit_ends: '29-08-2026'
      },
      supporting_documents: {
        identity_document_url: 'https://files.example.test/identity.pdf',
        avsec_endorsed_letter_url: 'https://files.example.test/endorsement.pdf',
        passport_photograph_url: 'https://files.example.test/photo.jpg',
        other_document_urls: ['https://files.example.test/supporting.pdf']
      }
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
    const applicationDetails = (await details.json()).application;
    const storedAreas = typeof applicationDetails.areas_of_access === 'string'
      ? JSON.parse(applicationDetails.areas_of_access)
      : applicationDetails.areas_of_access;
    const storedDocuments = typeof applicationDetails.supporting_documents === 'string'
      ? JSON.parse(applicationDetails.supporting_documents)
      : applicationDetails.supporting_documents;
    assert.equal(applicationDetails.status, 'CHECKED_OUT');
    assert.deepEqual(storedAreas, ['Main Terminal', 'Operations Office']);
    assert.equal(
      storedDocuments.avsec_endorsed_letter_url,
      'https://files.example.test/endorsement.pdf'
    );

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
