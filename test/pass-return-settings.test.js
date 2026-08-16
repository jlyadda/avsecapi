const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const app = require('../app');
const config = require('../config');
const db = require('../db');

test.after(() => db.end());

const createToken = async (userId) => {
  const jti = uuidv4();
  await db.execute(
    'INSERT INTO auth_tokens (jti, user_id, expires_at) VALUES (?, ?, ?)',
    [jti, userId, new Date(Date.now() + 300000)]
  );
  return jwt.sign({ id: userId }, config.JWT_SECRET, {
    algorithm: 'HS256', audience: 'avsec-clients', issuer: 'avsecapi',
    jwtid: jti, expiresIn: 300
  });
};

test('super admins configure the pass-return deadline while admins have read access', async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const superAdminId = uuidv4();
  const adminId = uuidv4();
  let originalHours;
  try {
    for (const [id, role] of [[superAdminId, 'super_admin'], [adminId, 'admin']]) {
      await db.execute(
        `INSERT INTO user_profiles
         (id, user_name, email, password_hash, user_role, is_active)
         VALUES (?, ?, ?, 'unused', ?, 1)`,
        [id, `pass.settings.${role}.${id.slice(0, 8)}`, `${id}@example.test`, role]
      );
    }
    const [[settings]] = await db.execute(
      'SELECT max_hold_hours FROM pass_return_settings WHERE id = 1'
    );
    originalHours = Number(settings.max_hold_hours);
    const superToken = await createToken(superAdminId);
    const adminToken = await createToken(adminId);
    const { port } = server.address();
    const endpoint = `http://127.0.0.1:${port}/api/operational-settings/pass-return`;

    const read = await fetch(endpoint, {
      headers: { authorization: `Bearer ${adminToken}` }
    });
    assert.equal(read.status, 200);
    assert.equal((await read.json()).settings.max_hold_hours, originalHours);

    const denied = await fetch(endpoint, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ max_hold_hours: 8 })
    });
    assert.equal(denied.status, 403);

    const updated = await fetch(endpoint, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${superToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ max_hold_hours: 8 })
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).settings.max_hold_hours, 8);
  } finally {
    if (originalHours !== undefined) {
      await db.execute(
        'UPDATE pass_return_settings SET max_hold_hours = ?, updated_by = NULL WHERE id = 1',
        [originalHours]
      );
    }
    await db.execute(
      'DELETE FROM audit_events WHERE actor_id IN (?, ?)',
      [superAdminId, adminId]
    );
    await db.execute(
      'DELETE FROM auth_tokens WHERE user_id IN (?, ?)',
      [superAdminId, adminId]
    );
    await db.execute(
      'DELETE FROM user_profiles WHERE id IN (?, ?)',
      [superAdminId, adminId]
    );
    await new Promise((resolve) => server.close(resolve));
  }
});
