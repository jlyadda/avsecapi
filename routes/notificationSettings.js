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
  authorizePermission(PERMISSIONS.MANAGE_NOTIFICATION_SETTINGS),
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

module.exports = router;
