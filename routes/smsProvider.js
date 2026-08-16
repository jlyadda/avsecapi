const express = require('express');
const db = require('../db');
const { authenticateToken, authorizePermission } = require('../middleware');
const { PERMISSIONS } = require('../permissions');
const { validate, schemas } = require('../validation');
const { recordAudit, sendError } = require('../audit');
const {
  getSmsBalance,
  getSmsDeliveryReport,
  getSmsInbox
} = require('../services/smsService');

const router = express.Router();

const providerError = (res, error, operation) => {
  const unavailable = ['SMS_NOT_CONFIGURED', 'SMS_TIMEOUT', 'SMS_PROVIDER_UNAVAILABLE']
    .includes(error.code);
  return sendError(
    res,
    unavailable ? 503 : 502,
    `SMS_PROVIDER_${operation}_FAILED`,
    unavailable ? 'SMS provider is unavailable.' : 'SMS provider rejected the request.'
  );
};

const auditProviderRead = (req, action, resourceId) => recordAudit(db, {
  actorId: req.user.id,
  action,
  resourceType: 'sms_provider',
  resourceId,
  requestId: req.requestId
});

router.get(
  '/sms-provider/balance',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_SMS_PROVIDER),
  async (req, res) => {
    try {
      const balance = await getSmsBalance();
      await auditProviderRead(req, 'SMS_PROVIDER_BALANCE_VIEWED', 'balance');
      return res.json({ balance });
    } catch (error) {
      console.error('SMS balance request failed:', error.code || error.message);
      return providerError(res, error, 'BALANCE');
    }
  }
);

router.get(
  '/sms-provider/delivery-reports/:message_id',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_SMS_PROVIDER),
  validate(schemas.smsDeliveryReport),
  async (req, res) => {
    try {
      const report = await getSmsDeliveryReport(req.params.message_id);
      await auditProviderRead(req, 'SMS_PROVIDER_DELIVERY_REPORT_VIEWED', req.params.message_id);
      return res.json({ report });
    } catch (error) {
      console.error('SMS delivery report request failed:', error.code || error.message);
      return providerError(res, error, 'DELIVERY_REPORT');
    }
  }
);

router.get(
  '/sms-provider/inbox',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_SMS_PROVIDER),
  async (req, res) => {
    try {
      const inbox = await getSmsInbox();
      await auditProviderRead(req, 'SMS_PROVIDER_INBOX_VIEWED', 'inbox');
      return res.json({ inbox });
    } catch (error) {
      console.error('SMS inbox request failed:', error.code || error.message);
      return providerError(res, error, 'INBOX');
    }
  }
);

module.exports = router;
