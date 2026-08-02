const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const app = require('../app');
const config = require('../config');
const db = require('../db');

test.after(() => db.end());

const createSession = async (userId, metadata = {}) => {
  const jti = uuidv4();
  const expiresAt = new Date(Date.now() + 300000);
  await db.execute(
    `INSERT INTO auth_tokens
     (jti, user_id, expires_at, ip_address, last_ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      jti,
      userId,
      expiresAt,
      metadata.ip || '127.0.0.1',
      metadata.ip || '127.0.0.1',
      metadata.userAgent || 'AVSEC automated test client'
    ]
  );
  return {
    jti,
    token: jwt.sign({ id: userId }, config.JWT_SECRET, {
      algorithm: 'HS256',
      audience: 'avsec-clients',
      issuer: 'avsecapi',
      jwtid: jti,
      expiresIn: 300
    })
  };
};

test('super admins monitor and revoke individual active sessions', async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const superAdminId = uuidv4();
  const adminId = uuidv4();
  const assistantId = uuidv4();
  let superSession;
  let adminSession;
  let assistantSession;

  try {
    for (const [id, role, name] of [
      [superAdminId, 'super_admin', 'Session Super Admin'],
      [adminId, 'admin', 'Session Admin'],
      [assistantId, 'security_assistant', 'Session Assistant']
    ]) {
      await db.execute(
        `INSERT INTO user_profiles
         (id, user_name, email, password_hash, full_name, department,
          user_role, is_active)
         VALUES (?, ?, ?, 'unused', ?, 'Aviation Security', ?, 1)`,
        [id, `session.${role}.${id.slice(0, 8)}`, `${id}@example.test`, name, role]
      );
    }
    superSession = await createSession(superAdminId);
    adminSession = await createSession(adminId);
    assistantSession = await createSession(assistantId, {
      ip: '192.0.2.25',
      userAgent: 'Access Pro Test Browser/1.0'
    });
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}/api`;

    const denied = await fetch(`${baseUrl}/admin/system-sessions`, {
      headers: { authorization: `Bearer ${adminSession.token}` }
    });
    assert.equal(denied.status, 403);

    const listed = await fetch(
      `${baseUrl}/admin/system-sessions?status=ACTIVE&search=Session%20Assistant`,
      { headers: { authorization: `Bearer ${superSession.token}` } }
    );
    assert.equal(listed.status, 200);
    const listBody = await listed.json();
    assert.equal(listBody.pagination.total, 1);
    const monitored = listBody.sessions[0];
    assert.equal(monitored.session_id, assistantSession.jti);
    assert.equal(monitored.ip_address, '192.0.2.25');
    assert.equal(monitored.last_ip_address, '192.0.2.25');
    assert.equal(monitored.user_agent, 'Access Pro Test Browser/1.0');
    assert.equal(monitored.status, 'ACTIVE');
    assert.ok(Number(monitored.configured_duration_seconds) > 0);
    assert.ok(Number(monitored.remaining_seconds) > 0);

    const revoke = await fetch(
      `${baseUrl}/admin/system-sessions/${assistantSession.jti}/revoke`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${superSession.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ reason: 'Automated session revocation verification.' })
      }
    );
    assert.equal(revoke.status, 200);

    const rejected = await fetch(`${baseUrl}/account`, {
      headers: { authorization: `Bearer ${assistantSession.token}` }
    });
    assert.equal(rejected.status, 403);

    const revokedList = await fetch(
      `${baseUrl}/admin/system-sessions?status=REVOKED&user_id=${assistantId}`,
      { headers: { authorization: `Bearer ${superSession.token}` } }
    );
    assert.equal(revokedList.status, 200);
    const revokedSession = (await revokedList.json()).sessions[0];
    assert.equal(revokedSession.revocation_reason, 'SUPER_ADMIN_REVOKED');
    assert.equal(revokedSession.revoked_by_id, superAdminId);
  } finally {
    await db.execute(
      `DELETE FROM audit_events
       WHERE actor_id IN (?, ?, ?) OR resource_id IN (?, ?, ?)`,
      [
        superAdminId,
        adminId,
        assistantId,
        superSession?.jti || '',
        adminSession?.jti || '',
        assistantSession?.jti || ''
      ]
    );
    await db.execute(
      'DELETE FROM auth_tokens WHERE user_id IN (?, ?, ?)',
      [superAdminId, adminId, assistantId]
    );
    await db.execute(
      'DELETE FROM user_profiles WHERE id IN (?, ?, ?)',
      [superAdminId, adminId, assistantId]
    );
    await new Promise((resolve) => server.close(resolve));
  }
});
