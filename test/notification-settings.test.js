const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const app = require('../app');
const config = require('../config');
const db = require('../db');
const { createSystemNotification } = require('../services/notificationService');

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

test('super admins control system email categories without disabling in-app delivery', async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const superAdminId = uuidv4();
  const adminId = uuidv4();
  const recipientId = uuidv4();
  let notificationId;
  let customTemplateCode;
  let originalEmailEnabled = true;

  try {
    for (const [id, role] of [
      [superAdminId, 'super_admin'],
      [adminId, 'admin'],
      [recipientId, 'security_assistant']
    ]) {
      await db.execute(
        `INSERT INTO user_profiles
         (id, user_name, email, password_hash, user_role, is_active)
         VALUES (?, ?, ?, 'unused', ?, 1)`,
        [
          id,
          `email.settings.${role}.${id.slice(0, 8)}`,
          `${id}@example.test`,
          role
        ]
      );
    }

    const superAdminToken = await createToken(superAdminId);
    const adminToken = await createToken(adminId);
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}/api`;
    const superAdminHeaders = {
      authorization: `Bearer ${superAdminToken}`,
      'content-type': 'application/json'
    };

    const denied = await fetch(
      `${baseUrl}/notification-settings/email-categories`,
      { headers: { authorization: `Bearer ${adminToken}` } }
    );
    assert.equal(denied.status, 403);

    const listResponse = await fetch(
      `${baseUrl}/notification-settings/email-categories`,
      { headers: superAdminHeaders }
    );
    assert.equal(listResponse.status, 200);
    const categories = (await listResponse.json()).categories;
    const cardCategory = categories.find(
      (category) => category.code === 'ACCESS_CARDS'
    );
    assert.ok(cardCategory);
    originalEmailEnabled = cardCategory.email_enabled;

    const disableResponse = await fetch(
      `${baseUrl}/notification-settings/email-categories/ACCESS_CARDS`,
      {
        method: 'PATCH',
        headers: superAdminHeaders,
        body: JSON.stringify({ email_enabled: false })
      }
    );
    assert.equal(disableResponse.status, 200);

    customTemplateCode = `CUSTOM_ACCESS_${Date.now()}`;
    const createdTemplateResponse = await fetch(
      `${baseUrl}/notification-email-templates`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          code: customTemplateCode,
          category_code: 'ACCESS_CARDS',
          name: 'Custom access-card reminder',
          title_template: 'Return access card {{number}}',
          body_template: 'Please return access card {{number}} before {{deadline}}.',
          default_priority: 'HIGH'
        })
      }
    );
    assert.equal(createdTemplateResponse.status, 201);
    const createdTemplate = (await createdTemplateResponse.json()).template;
    assert.equal(createdTemplate.category_code, 'ACCESS_CARDS');
    assert.equal(createdTemplate.is_system, false);

    const templatesResponse = await fetch(
      `${baseUrl}/notification-email-templates?category_code=ACCESS_CARDS`,
      { headers: { authorization: `Bearer ${adminToken}` } }
    );
    assert.equal(templatesResponse.status, 200);
    assert.equal(
      (await templatesResponse.json()).templates.some(
        (template) => template.code === customTemplateCode
      ),
      true
    );

    const adminSystemEdit = await fetch(
      `${baseUrl}/notification-email-templates/ACCESS_CARD_ALERT`,
      {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ name: 'Unsafe system template edit' })
      }
    );
    assert.equal(adminSystemEdit.status, 403);

    const customTemplateUpdate = await fetch(
      `${baseUrl}/notification-email-templates/${customTemplateCode}`,
      {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ default_priority: 'CRITICAL' })
      }
    );
    assert.equal(customTemplateUpdate.status, 200);

    const notification = await createSystemNotification(db, {
      templateCode: 'ACCESS_CARD_ALERT',
      values: { number: 'TEST001', status: 'lost' },
      requestId: uuidv4(),
      resourceType: 'access_card',
      resourceId: uuidv4(),
      targets: [{ type: 'USER', value: recipientId }],
      channels: ['IN_APP', 'EMAIL']
    });
    notificationId = notification.id;
    assert.ok(notificationId);

    const [[storedNotification]] = await db.execute(
      'SELECT channels FROM notifications WHERE id = ?',
      [notificationId]
    );
    const channels = typeof storedNotification.channels === 'string'
      ? JSON.parse(storedNotification.channels)
      : storedNotification.channels;
    assert.deepEqual(channels, ['IN_APP']);

    const [deliveries] = await db.execute(
      'SELECT channel FROM notification_deliveries WHERE notification_id = ?',
      [notificationId]
    );
    assert.deepEqual(deliveries.map((delivery) => delivery.channel), ['IN_APP']);

    const [[outbox]] = await db.execute(
      'SELECT COUNT(*) AS total FROM notification_outbox WHERE notification_id = ?',
      [notificationId]
    );
    assert.equal(Number(outbox.total), 0);
  } finally {
    await db.execute(
      'UPDATE notification_email_categories SET email_enabled = ? WHERE code = ?',
      [originalEmailEnabled, 'ACCESS_CARDS']
    );
    if (customTemplateCode) {
      await db.execute(
        'DELETE FROM notification_templates WHERE code = ?',
        [customTemplateCode]
      );
    }
    if (notificationId) {
      await db.execute('DELETE FROM notifications WHERE id = ?', [notificationId]);
    }
    await db.execute(
      'DELETE FROM audit_events WHERE actor_id IN (?, ?)',
      [superAdminId, adminId]
    );
    await db.execute(
      'DELETE FROM auth_tokens WHERE user_id IN (?, ?, ?)',
      [superAdminId, adminId, recipientId]
    );
    await db.execute(
      'DELETE FROM user_profiles WHERE id IN (?, ?, ?)',
      [superAdminId, adminId, recipientId]
    );
    await new Promise((resolve) => server.close(resolve));
  }
});
