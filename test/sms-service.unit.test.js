const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config');
const { schemas } = require('../validation');
const {
  buildSmsMessage,
  getSmsBalance,
  getSmsDeliveryReport,
  getSmsInbox,
  normalizePhoneNumber,
  sendNotificationSms
} = require('../services/smsService');

test('normalizes local and international Uganda phone numbers', () => {
  assert.equal(normalizePhoneNumber('0701 405 780'), '256701405780');
  assert.equal(normalizePhoneNumber('+256 701 405 780'), '256701405780');
  assert.equal(normalizePhoneNumber('00256-701-405-780'), '256701405780');
});

test('rejects invalid phone numbers permanently', () => {
  assert.throws(
    () => normalizePhoneNumber('not-a-number'),
    (error) => error.code === 'SMS_INVALID_PHONE' && error.permanent === true
  );
});

test('administrator broadcasts cannot select the SMS channel', () => {
  const result = schemas.notificationCreate.safeParse({
    body: {
      title: 'Test notice',
      body: 'Internal notice',
      channels: ['SMS'],
      targets: [{ type: 'ALL' }]
    }
  });
  assert.equal(result.success, false);
});

test('limits SMS text to the configured maximum', () => {
  const originalMaximum = config.SMS_MAX_LENGTH;
  config.SMS_MAX_LENGTH = 70;
  try {
    const message = buildSmsMessage({ title: 'Alert', body: 'x'.repeat(100) });
    assert.equal(message.length, 70);
    assert.ok(message.endsWith('…'));
  } finally {
    config.SMS_MAX_LENGTH = originalMaximum;
  }
});

test('sends Yoola SMS without exposing credentials in the result', async () => {
  const originalFetch = global.fetch;
  const originalKey = config.YOOLA_SMS_API_KEY;
  const originalUrl = config.YOOLA_SMS_API_URL;
  config.YOOLA_SMS_API_KEY = 'test-api-key';
  config.YOOLA_SMS_API_URL = 'https://yoolasms.invalid/api/v1/send_sms';
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ status: 'success', message_id: 'YL-123' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const result = await sendNotificationSms({
      phone: '+256701405780',
      title: 'AVSEC',
      body: 'Application approved.'
    });
    const payload = JSON.parse(request.options.body);
    assert.equal(String(request.url), config.YOOLA_SMS_API_URL);
    assert.equal(payload.phone, '256701405780');
    assert.equal(payload.api_key, 'test-api-key');
    assert.equal(result.messageId, 'YL-123');
    assert.deepEqual(Object.keys(result), ['messageId']);
  } finally {
    global.fetch = originalFetch;
    config.YOOLA_SMS_API_KEY = originalKey;
    config.YOOLA_SMS_API_URL = originalUrl;
  }
});

test('uses Yoola balance, delivery report and inbox endpoints', async () => {
  const originalFetch = global.fetch;
  const originalKey = config.YOOLA_SMS_API_KEY;
  const originalUrl = config.YOOLA_SMS_API_URL;
  config.YOOLA_SMS_API_KEY = 'test-api-key';
  config.YOOLA_SMS_API_URL = 'https://yoolasms.invalid/api/v1/send_sms';
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({ status: 'success' }), { status: 200 });
  };

  try {
    await getSmsBalance();
    await getSmsDeliveryReport('YL-123');
    await getSmsInbox();
    assert.deepEqual(requests.slice(0, 2).map((request) => request.url), [
      'https://yoolasms.invalid/api/v1/balance',
      'https://yoolasms.invalid/api/v1/delivery_report'
    ]);
    assert.equal(JSON.parse(requests[1].options.body).message_id, 'YL-123');
    assert.equal(requests[2].options.method, 'GET');
    assert.equal(requests[2].options.headers.Authorization, 'Bearer test-api-key');
    const inboxUrl = new URL(requests[2].url);
    assert.equal(`${inboxUrl.origin}${inboxUrl.pathname}`,
      'https://yoolasms.invalid/api/v1/inbox');
    assert.equal(inboxUrl.searchParams.get('api_key'), 'test-api-key');
  } finally {
    global.fetch = originalFetch;
    config.YOOLA_SMS_API_KEY = originalKey;
    config.YOOLA_SMS_API_URL = originalUrl;
  }
});
