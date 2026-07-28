const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
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
    algorithm: 'HS256',
    audience: 'avsec-clients',
    issuer: 'avsecapi',
    jwtid: jti,
    expiresIn: 300
  });
};

test('notification groups, broadcasts and inbox state are persisted', async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const adminId = uuidv4();
  const assistantId = uuidv4();
  let groupId;
  let notificationId;

  try {
    for (const [id, role] of [
      [adminId, 'admin'],
      [assistantId, 'security_assistant']
    ]) {
      await db.execute(
        `INSERT INTO user_profiles
         (id, user_name, email, password_hash, user_role, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [
          id,
          `notification.${role}.${id.slice(0, 8)}`,
          `${id}@example.test`,
          await bcrypt.hash('NotificationPassword12!', 12),
          role
        ]
      );
    }
    const adminToken = await createToken(adminId);
    const assistantToken = await createToken(assistantId);
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}/api`;
    const adminHeaders = {
      authorization: `Bearer ${adminToken}`,
      'content-type': 'application/json'
    };
    const assistantHeaders = {
      authorization: `Bearer ${assistantToken}`,
      'content-type': 'application/json'
    };

    const groupResponse = await fetch(`${baseUrl}/notification-groups`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: `Night Shift ${adminId.slice(0, 8)}`,
        description: 'Automated notification test group.',
        user_ids: [assistantId]
      })
    });
    assert.equal(groupResponse.status, 201);
    groupId = (await groupResponse.json()).group.id;

    const notificationResponse = await fetch(`${baseUrl}/notifications`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        type: 'SHIFT_NOTICE',
        title: 'Night shift briefing',
        body: 'Report to the briefing room.',
        priority: 'HIGH',
        channels: ['IN_APP', 'EMAIL'],
        targets: [{ type: 'GROUP', value: groupId }]
      })
    });
    assert.equal(notificationResponse.status, 201);
    const notification = (await notificationResponse.json()).notification;
    notificationId = notification.id;
    assert.equal(notification.recipientCount, 1);

    const countResponse = await fetch(`${baseUrl}/notifications/unread-count`, {
      headers: assistantHeaders
    });
    assert.equal(countResponse.status, 200);
    assert.equal((await countResponse.json()).unread, 1);

    const inboxResponse = await fetch(`${baseUrl}/notifications?unread=true`, {
      headers: assistantHeaders
    });
    assert.equal(inboxResponse.status, 200);
    assert.equal((await inboxResponse.json()).notifications[0].id, notificationId);

    const readResponse = await fetch(`${baseUrl}/notifications/${notificationId}/read`, {
      method: 'PATCH',
      headers: assistantHeaders,
      body: '{}'
    });
    assert.equal(readResponse.status, 200);

    const deliveryResponse = await fetch(
      `${baseUrl}/notifications/${notificationId}/deliveries`,
      { headers: adminHeaders }
    );
    assert.equal(deliveryResponse.status, 200);
    const deliveries = (await deliveryResponse.json()).deliveries;
    assert.equal(deliveries.some((delivery) => delivery.channel === 'EMAIL'), true);

    const [[outbox]] = await db.execute(
      'SELECT status FROM notification_outbox WHERE notification_id = ?',
      [notificationId]
    );
    assert.equal(outbox.status, 'PENDING');

    const archiveResponse = await fetch(
      `${baseUrl}/notifications/${notificationId}/archive`,
      { method: 'PATCH', headers: assistantHeaders, body: '{}' }
    );
    assert.equal(archiveResponse.status, 200);
  } finally {
    if (notificationId) {
      await db.execute('DELETE FROM notifications WHERE id = ?', [notificationId]);
    }
    await db.execute('DELETE FROM audit_events WHERE actor_id = ?', [adminId]);
    if (groupId) {
      await db.execute('DELETE FROM notification_groups WHERE id = ?', [groupId]);
    }
    await db.execute(
      'DELETE FROM auth_tokens WHERE user_id IN (?, ?)',
      [adminId, assistantId]
    );
    await db.execute(
      'DELETE FROM user_profiles WHERE id IN (?, ?)',
      [adminId, assistantId]
    );
    await new Promise((resolve) => server.close(resolve));
  }
});
