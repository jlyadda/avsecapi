const express = require('express');
const db = require('../db');
const { authenticateToken, authorizePermission } = require('../middleware');
const { PERMISSIONS } = require('../permissions');
const { validate, schemas } = require('../validation');
const { recordAudit, sendError } = require('../audit');

const router = express.Router();

router.get(
  '/notification-settings/email-categories',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_NOTIFICATION_SETTINGS),
  async (req, res) => {
    try {
      const [categories] = await db.query(
        `SELECT code, name, description, email_enabled, is_active,
                created_at, updated_at
         FROM notification_email_categories
         ORDER BY name`
      );
      return res.json({
        categories: categories.map((category) => ({
          ...category,
          email_enabled: Boolean(category.email_enabled)
        }))
      });
    } catch (error) {
      console.error(error);
      return sendError(
        res,
        500,
        'NOTIFICATION_EMAIL_CATEGORY_LIST_FAILED',
        'Unable to load email notification categories.'
      );
    }
  }
);

router.patch(
  '/notification-settings/email-categories/:code',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_NOTIFICATION_SETTINGS),
  validate(schemas.notificationEmailCategoryUpdate),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [categories] = await connection.execute(
        `SELECT code
         FROM notification_email_categories
         WHERE code = ? AND is_active = 1
         FOR UPDATE`,
        [req.params.code]
      );
      if (!categories[0]) {
        await connection.rollback();
        return sendError(
          res,
          404,
          'NOTIFICATION_EMAIL_CATEGORY_NOT_FOUND',
          'Email notification category not found.'
        );
      }
      await connection.execute(
        `UPDATE notification_email_categories
         SET email_enabled = ?
         WHERE code = ? AND is_active = 1`,
        [req.body.email_enabled, req.params.code]
      );
      await recordAudit(connection, {
        actorId: req.user.id,
        action: req.body.email_enabled
          ? 'NOTIFICATION_EMAIL_CATEGORY_ENABLED'
          : 'NOTIFICATION_EMAIL_CATEGORY_DISABLED',
        resourceType: 'notification_email_category',
        resourceId: req.params.code,
        requestId: req.requestId,
        metadata: {
          code: req.params.code,
          email_enabled: req.body.email_enabled
        }
      });
      await connection.commit();
      return res.json({
        category: {
          code: req.params.code,
          email_enabled: req.body.email_enabled
        },
        message: `Email notifications for ${req.params.code} ${
          req.body.email_enabled ? 'enabled' : 'disabled'
        }.`
      });
    } catch (error) {
      await connection.rollback();
      console.error(error);
      return sendError(
        res,
        500,
        'NOTIFICATION_EMAIL_CATEGORY_UPDATE_FAILED',
        'Unable to update the email notification category.'
      );
    } finally {
      connection.release();
    }
  }
);

router.get(
  '/notification-settings/sms-categories',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_NOTIFICATION_SETTINGS),
  async (req, res) => {
    try {
      const [categories] = await db.query(
        `SELECT code, name, description, sms_enabled, is_active,
                created_at, updated_at
         FROM notification_email_categories
         ORDER BY name`
      );
      return res.json({
        categories: categories.map((category) => ({
          ...category,
          sms_enabled: Boolean(category.sms_enabled),
          is_active: Boolean(category.is_active)
        }))
      });
    } catch (error) {
      console.error(error);
      return sendError(res, 500, 'NOTIFICATION_SMS_CATEGORY_LIST_FAILED',
        'Unable to load SMS notification categories.');
    }
  }
);

router.patch(
  '/notification-settings/sms-categories/:code',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_NOTIFICATION_SETTINGS),
  validate(schemas.notificationSmsCategoryUpdate),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute(
        `UPDATE notification_email_categories
         SET sms_enabled = ? WHERE code = ? AND is_active = 1`,
        [req.body.sms_enabled, req.params.code]
      );
      if (result.affectedRows === 0) {
        await connection.rollback();
        return sendError(res, 404, 'NOTIFICATION_SMS_CATEGORY_NOT_FOUND',
          'SMS notification category not found.');
      }
      await recordAudit(connection, {
        actorId: req.user.id,
        action: req.body.sms_enabled
          ? 'NOTIFICATION_SMS_CATEGORY_ENABLED'
          : 'NOTIFICATION_SMS_CATEGORY_DISABLED',
        resourceType: 'notification_sms_category',
        resourceId: req.params.code,
        requestId: req.requestId,
        metadata: { code: req.params.code, sms_enabled: req.body.sms_enabled }
      });
      await connection.commit();
      return res.json({
        category: { code: req.params.code, sms_enabled: req.body.sms_enabled }
      });
    } catch (error) {
      await connection.rollback();
      console.error(error);
      return sendError(res, 500, 'NOTIFICATION_SMS_CATEGORY_UPDATE_FAILED',
        'Unable to update the SMS notification category.');
    } finally {
      connection.release();
    }
  }
);

router.get(
  '/notification-settings/sms-recipients',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_NOTIFICATION_SETTINGS),
  async (req, res) => {
    try {
      const [recipients] = await db.query(
        `SELECT code, name, description, sms_enabled, is_active,
                created_at, updated_at
         FROM notification_sms_recipient_settings
         ORDER BY name`
      );
      return res.json({
        recipients: recipients.map((recipient) => ({
          ...recipient,
          sms_enabled: Boolean(recipient.sms_enabled),
          is_active: Boolean(recipient.is_active)
        }))
      });
    } catch (error) {
      console.error(error);
      return sendError(res, 500, 'NOTIFICATION_SMS_RECIPIENT_LIST_FAILED',
        'Unable to load SMS recipient settings.');
    }
  }
);

router.patch(
  '/notification-settings/sms-recipients/:recipient_type',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_NOTIFICATION_SETTINGS),
  validate(schemas.notificationSmsRecipientUpdate),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute(
        `UPDATE notification_sms_recipient_settings
         SET sms_enabled = ?, updated_by = ?
         WHERE code = ? AND is_active = 1`,
        [req.body.sms_enabled, req.user.id, req.params.recipient_type]
      );
      if (result.affectedRows === 0) {
        await connection.rollback();
        return sendError(res, 404, 'NOTIFICATION_SMS_RECIPIENT_NOT_FOUND',
          'SMS recipient setting not found.');
      }
      await recordAudit(connection, {
        actorId: req.user.id,
        action: req.body.sms_enabled
          ? 'NOTIFICATION_SMS_RECIPIENT_ENABLED'
          : 'NOTIFICATION_SMS_RECIPIENT_DISABLED',
        resourceType: 'notification_sms_recipient',
        resourceId: req.params.recipient_type,
        requestId: req.requestId,
        metadata: {
          recipient_type: req.params.recipient_type,
          sms_enabled: req.body.sms_enabled
        }
      });
      await connection.commit();
      return res.json({
        recipient: {
          code: req.params.recipient_type,
          sms_enabled: req.body.sms_enabled
        }
      });
    } catch (error) {
      await connection.rollback();
      console.error(error);
      return sendError(res, 500, 'NOTIFICATION_SMS_RECIPIENT_UPDATE_FAILED',
        'Unable to update the SMS recipient setting.');
    } finally {
      connection.release();
    }
  }
);

module.exports = router;
