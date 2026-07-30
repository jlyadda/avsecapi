const test = require('node:test');
const assert = require('node:assert/strict');
const { createSystemNotification } = require('../services/notificationService');

const createExecutor = () => {
  const calls = [];
  const executor = {
    execute: async (sql, parameters = []) => {
      calls.push({ sql, parameters });
      if (sql.includes('FROM notification_templates')) {
        return [[{
          code: 'ACCESS_CARD_ALERT',
          title_template: 'Access card {{status}}',
          body_template: 'Access card {{number}} was marked {{status}}.',
          default_priority: 'HIGH',
          email_enabled: 0
        }]];
      }
      if (sql.includes('FROM user_profiles') && sql.includes('WHERE id = ?')) {
        return [[{
          id: 'recipient-user-id',
          email: 'recipient@example.test'
        }]];
      }
      return [{ affectedRows: 1 }];
    }
  };
  return { executor, calls };
};

test('disabled system email categories retain requested in-app delivery', async () => {
  const { executor, calls } = createExecutor();
  const result = await createSystemNotification(executor, {
    templateCode: 'ACCESS_CARD_ALERT',
    values: { number: 'TEST001', status: 'lost' },
    requestId: 'request-id',
    resourceType: 'access_card',
    resourceId: 'card-id',
    targets: [{ type: 'USER', value: 'recipient-user-id' }],
    channels: ['IN_APP', 'EMAIL']
  });

  assert.ok(result.id);
  const notificationInsert = calls.find((call) =>
    call.sql.includes('INSERT INTO notifications')
  );
  assert.equal(notificationInsert.parameters[10], JSON.stringify(['IN_APP']));
  assert.equal(
    calls.some((call) => call.sql.includes('notification_outbox')),
    false
  );
  assert.equal(
    calls.some((call) => call.sql.includes("recipient_email, channel")),
    false
  );
  assert.equal(
    calls.some((call) => call.sql.includes("'IN_APP', 'SENT'")),
    true
  );
});

test('disabled email-only system notifications are skipped safely', async () => {
  const { executor, calls } = createExecutor();
  const result = await createSystemNotification(executor, {
    templateCode: 'ACCESS_CARD_ALERT',
    values: { number: 'TEST001', status: 'lost' },
    requestId: 'request-id',
    resourceType: 'access_card',
    resourceId: 'card-id',
    targets: [{ type: 'EXTERNAL_EMAIL', value: 'visitor@example.test' }],
    channels: ['EMAIL']
  });

  assert.equal(result.id, null);
  assert.equal(result.emailDisabled, true);
  assert.equal(calls.length, 1);
});
