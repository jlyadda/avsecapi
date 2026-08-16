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

test('SMS category, recipient and template controls govern applicant delivery', async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const superAdminId = uuidv4();
  const adminId = uuidv4();
  const notificationIds = [];
  let originalCategoryEnabled;
  let originalRecipientEnabled;
  let originalBody;

  try {
    for (const [id, role] of [[superAdminId, 'super_admin'], [adminId, 'admin']]) {
      await db.execute(
        `INSERT INTO user_profiles
         (id, user_name, email, password_hash, user_role, is_active)
         VALUES (?, ?, ?, 'unused', ?, 1)`,
        [id, `sms.settings.${role}.${id.slice(0, 8)}`, `${id}@example.test`, role]
      );
    }
    const [[category]] = await db.execute(
      `SELECT sms_enabled FROM notification_email_categories
       WHERE code = 'APPROVAL_WORKFLOWS'`
    );
    const [[recipient]] = await db.execute(
      `SELECT sms_enabled FROM notification_sms_recipient_settings
       WHERE code = 'VISITOR_APPLICANT'`
    );
    const [[template]] = await db.execute(
      `SELECT body_template FROM notification_sms_templates
       WHERE code = 'VISITOR_WORKFLOW_COMPLETED'`
    );
    originalCategoryEnabled = category.sms_enabled;
    originalRecipientEnabled = recipient.sms_enabled;
    originalBody = template.body_template;

    const superAdminToken = await createToken(superAdminId);
    const adminToken = await createToken(adminId);
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}/api`;
    const headers = {
      authorization: `Bearer ${superAdminToken}`,
      'content-type': 'application/json'
    };

    const categoriesResponse = await fetch(
      `${baseUrl}/notification-settings/sms-categories`,
      { headers: { authorization: `Bearer ${adminToken}` } }
    );
    assert.equal(categoriesResponse.status, 200);

    const deniedCategoryUpdate = await fetch(
      `${baseUrl}/notification-settings/sms-categories/APPROVAL_WORKFLOWS`,
      {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ sms_enabled: false })
      }
    );
    assert.equal(deniedCategoryUpdate.status, 403);

    const setCategory = (smsEnabled) => fetch(
      `${baseUrl}/notification-settings/sms-categories/APPROVAL_WORKFLOWS`,
      { method: 'PATCH', headers, body: JSON.stringify({ sms_enabled: smsEnabled }) }
    );
    const setRecipient = (smsEnabled) => fetch(
      `${baseUrl}/notification-settings/sms-recipients/VISITOR_APPLICANT`,
      { method: 'PATCH', headers, body: JSON.stringify({ sms_enabled: smsEnabled }) }
    );
    const createVisitorSms = () => createSystemNotification(db, {
      templateCode: 'VISITOR_WORKFLOW_COMPLETED',
      values: { reference: 'AVSEC-TEST', decision: 'approved' },
      requestId: uuidv4(),
      resourceType: 'visitor_application',
      resourceId: uuidv4(),
      targets: [{ type: 'EXTERNAL_SMS', value: '+256701405780' }],
      channels: ['SMS'],
      recipientType: 'VISITOR_APPLICANT'
    });

    assert.equal((await setCategory(false)).status, 200);
    const categoryDisabled = await createVisitorSms();
    assert.equal(categoryDisabled.id, null);
    assert.equal(categoryDisabled.smsDisabled, true);

    assert.equal((await setCategory(true)).status, 200);
    assert.equal((await setRecipient(false)).status, 200);
    const recipientDisabled = await createVisitorSms();
    assert.equal(recipientDisabled.id, null);
    assert.equal(recipientDisabled.smsDisabled, true);

    assert.equal((await setRecipient(true)).status, 200);
    const templatesResponse = await fetch(
      `${baseUrl}/notification-sms-templates?category_code=APPROVAL_WORKFLOWS`,
      { headers: { authorization: `Bearer ${adminToken}` } }
    );
    assert.equal(templatesResponse.status, 200);

    const deniedSystemEdit = await fetch(
      `${baseUrl}/notification-sms-templates/VISITOR_WORKFLOW_COMPLETED`,
      {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ body_template: 'Unsafe {{reference}}' })
      }
    );
    assert.equal(deniedSystemEdit.status, 403);

    const bodyTemplate = 'AVSEC decision for {{reference}}: {{decision}}.';
    const updateTemplate = await fetch(
      `${baseUrl}/notification-sms-templates/VISITOR_WORKFLOW_COMPLETED`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ body_template: bodyTemplate })
      }
    );
    assert.equal(updateTemplate.status, 200);

    const enabled = await createVisitorSms();
    notificationIds.push(enabled.id);
    const [[delivery]] = await db.execute(
      `SELECT channel, content_override FROM notification_deliveries
       WHERE notification_id = ?`,
      [enabled.id]
    );
    assert.equal(delivery.channel, 'SMS');
    assert.equal(delivery.content_override, 'AVSEC decision for AVSEC-TEST: approved.');
  } finally {
    if (originalCategoryEnabled !== undefined) {
      await db.execute(
        `UPDATE notification_email_categories SET sms_enabled = ?
         WHERE code = 'APPROVAL_WORKFLOWS'`,
        [originalCategoryEnabled]
      );
    }
    if (originalRecipientEnabled !== undefined) {
      await db.execute(
        `UPDATE notification_sms_recipient_settings
         SET sms_enabled = ?, updated_by = NULL WHERE code = 'VISITOR_APPLICANT'`,
        [originalRecipientEnabled]
      );
    }
    if (originalBody !== undefined) {
      await db.execute(
        `UPDATE notification_sms_templates SET body_template = ?
         WHERE code = 'VISITOR_WORKFLOW_COMPLETED'`,
        [originalBody]
      );
    }
    for (const notificationId of notificationIds.filter(Boolean)) {
      await db.execute('DELETE FROM notifications WHERE id = ?', [notificationId]);
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
