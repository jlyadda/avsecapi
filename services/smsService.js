const config = require('../config');

const getEndpointUrl = (endpoint) => {
  const configuredUrl = new URL(config.YOOLA_SMS_API_URL);
  configuredUrl.pathname = `${configuredUrl.pathname.replace(/\/[^/]*$/, '')}/${endpoint}`;
  configuredUrl.search = '';
  return configuredUrl;
};

const requestYoola = async ({ endpoint, method = 'POST', data = {} }) => {
  if (!config.YOOLA_SMS_API_KEY) {
    const error = new Error('SMS delivery is not configured.');
    error.code = 'SMS_NOT_CONFIGURED';
    error.permanent = true;
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.YOOLA_SMS_TIMEOUT_MS);
  const endpointUrl = getEndpointUrl(endpoint);
  if (method === 'GET') endpointUrl.searchParams.set('api_key', config.YOOLA_SMS_API_KEY);
  let response;
  try {
    response = await fetch(endpointUrl, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.YOOLA_SMS_API_KEY}`,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {})
      },
      ...(method === 'POST' ? {
        body: JSON.stringify({ api_key: config.YOOLA_SMS_API_KEY, ...data })
      } : {}),
      signal: controller.signal
    });
  } catch (cause) {
    const error = new Error(cause.name === 'AbortError'
      ? 'SMS provider request timed out.'
      : 'SMS provider request failed.');
    error.code = cause.name === 'AbortError' ? 'SMS_TIMEOUT' : 'SMS_PROVIDER_UNAVAILABLE';
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const responseText = await response.text();
  let payload = {};
  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    payload = {};
  }

  const providerStatus = String(payload.status || '').toLowerCase();
  if (!response.ok || ['error', 'failed', 'failure'].includes(providerStatus)) {
    const error = new Error('SMS provider rejected the request.');
    error.code = `SMS_PROVIDER_${response.status}`;
    error.permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
    throw error;
  }
  return payload;
};

const normalizePhoneNumber = (value) => {
  let digits = String(value || '').trim().replace(/[^0-9+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `${config.SMS_DEFAULT_COUNTRY_CODE}${digits.slice(1)}`;
  if (!/^\d{8,15}$/.test(digits)) {
    const error = new Error('Recipient phone number is invalid.');
    error.code = 'SMS_INVALID_PHONE';
    error.permanent = true;
    throw error;
  }
  return digits;
};

const buildSmsMessage = ({ title, body }) => {
  const message = [title, body].filter(Boolean).join(': ').replace(/\s+/g, ' ').trim();
  if (message.length <= config.SMS_MAX_LENGTH) return message;
  return `${message.slice(0, config.SMS_MAX_LENGTH - 1).trimEnd()}…`;
};

const sendNotificationSms = async ({ phone, title, body }) => {
  const payload = await requestYoola({
    endpoint: 'send_sms',
    data: {
      phone: normalizePhoneNumber(phone),
      message: buildSmsMessage({ title, body })
    }
  });

  return {
    messageId: payload.message_id ? String(payload.message_id).slice(0, 255) : null
  };
};

const getSmsBalance = () => requestYoola({ endpoint: 'balance' });

const getSmsDeliveryReport = (messageId) => requestYoola({
  endpoint: 'delivery_report',
  data: { message_id: messageId }
});

const getSmsInbox = () => requestYoola({ endpoint: 'inbox', method: 'GET' });

module.exports = {
  buildSmsMessage,
  getSmsBalance,
  getSmsDeliveryReport,
  getSmsInbox,
  normalizePhoneNumber,
  requestYoola,
  sendNotificationSms
};
