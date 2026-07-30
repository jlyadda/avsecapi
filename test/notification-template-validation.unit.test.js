const test = require('node:test');
const assert = require('node:assert/strict');
const { schemas } = require('../validation');
const { PERMISSIONS, hasPermission } = require('../permissions');

test('admins and super admins can manage notification email templates', () => {
  assert.equal(
    hasPermission('admin', PERMISSIONS.MANAGE_NOTIFICATION_TEMPLATES),
    true
  );
  assert.equal(
    hasPermission('super_admin', PERMISSIONS.MANAGE_NOTIFICATION_TEMPLATES),
    true
  );
  assert.equal(
    hasPermission('supervisor', PERMISSIONS.MANAGE_NOTIFICATION_TEMPLATES),
    false
  );
});

test('notification email template creation validates category and placeholders', () => {
  const result = schemas.notificationTemplateCreate.safeParse({
    body: {
      code: 'ACCESS_CARD_RETURN_REMINDER',
      category_code: 'ACCESS_CARDS',
      name: 'Access card return reminder',
      title_template: 'Return access card {{number}}',
      body_template: 'Return card {{number}} before {{deadline}}.',
      default_priority: 'HIGH',
      is_active: true
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.data.body.category_code, 'ACCESS_CARDS');
});

test('notification template creation rejects unknown fields and invalid codes', () => {
  const result = schemas.notificationTemplateCreate.safeParse({
    body: {
      code: 'invalid template code',
      category_code: 'ACCESS_CARDS',
      name: 'Invalid template',
      title_template: 'Invalid title',
      body_template: 'Invalid body',
      unexpected: true
    }
  });

  assert.equal(result.success, false);
});
