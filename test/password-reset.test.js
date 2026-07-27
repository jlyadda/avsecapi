const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const app = require('../app');
const db = require('../db');
const { hashOtp } = require('../passwordResetOtp');

test.after(() => db.end());

test('password reset OTP is single-use and revokes active sessions', async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const userId = uuidv4();
  const resetId = uuidv4();
  const sessionId = uuidv4();
  const email = `${userId}@example.test`;
  const otp = '54321';

  try {
    await db.execute(
      `INSERT INTO user_profiles
       (id, user_name, email, password_hash, user_role, is_active)
       VALUES (?, ?, ?, ?, 'security_assistant', 1)`,
      [
        userId,
        `reset.${userId.slice(0, 8)}`,
        email,
        await bcrypt.hash('InitialPassword12!', 12)
      ]
    );
    await db.execute(
      'INSERT INTO auth_tokens (jti, user_id, expires_at) VALUES (?, ?, ?)',
      [sessionId, userId, new Date(Date.now() + 300000)]
    );
    await db.execute(
      `INSERT INTO password_reset_otps
       (id, user_id, otp_hash, expires_at)
       VALUES (?, ?, ?, ?)`,
      [resetId, userId, hashOtp(userId, otp), new Date(Date.now() + 300000)]
    );

    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/password-reset/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        otp,
        new_password: 'ReplacementPassword12!'
      })
    });
    assert.equal(response.status, 200);

    const [[user]] = await db.execute(
      'SELECT password_hash FROM user_profiles WHERE id = ?',
      [userId]
    );
    assert.equal(await bcrypt.compare('ReplacementPassword12!', user.password_hash), true);

    const [[session]] = await db.execute(
      'SELECT revoked_at FROM auth_tokens WHERE jti = ?',
      [sessionId]
    );
    assert.ok(session.revoked_at);

    const replay = await fetch(`http://127.0.0.1:${port}/api/password-reset/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        otp,
        new_password: 'AnotherPassword12!'
      })
    });
    assert.equal(replay.status, 400);
  } finally {
    await db.execute('DELETE FROM password_reset_otps WHERE user_id = ?', [userId]);
    await db.execute('DELETE FROM auth_tokens WHERE user_id = ?', [userId]);
    await db.execute('DELETE FROM user_profiles WHERE id = ?', [userId]);
    await new Promise((resolve) => server.close(resolve));
  }
});
