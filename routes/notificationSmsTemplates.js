const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authenticateToken, authorizePermission } = require('../middleware');
const { PERMISSIONS } = require('../permissions');
const { validate, schemas } = require('../validation');
const { recordAudit, sendError } = require('../audit');

const router = express.Router();

const ensureReferences = async (executor, code, categoryCode, recipientType) => {
  const [rows] = await executor.execute(
    `SELECT template.code
     FROM notification_templates template
     INNER JOIN notification_email_categories category
       ON category.code = template.category_code AND category.is_active = 1
     INNER JOIN notification_sms_recipient_settings recipient
       ON recipient.code = ? AND recipient.is_active = 1
     WHERE template.code = ? AND template.category_code = ?`,
    [recipientType, code, categoryCode]
  );
  if (!rows[0]) {
    const error = new Error('Template event, category, or recipient type is invalid.');
    error.status = 422;
    error.code = 'NOTIFICATION_SMS_TEMPLATE_REFERENCE_INVALID';
    throw error;
  }
};

router.get(
  '/notification-sms-templates',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_NOTIFICATION_TEMPLATES),
  validate(schemas.notificationSmsTemplateList),
  async (req, res) => {
    try {
      const { category_code, is_active, page, page_size } = req.validatedQuery;
      const conditions = [];
      const values = [];
      if (category_code) {
        conditions.push('template.category_code = ?');
        values.push(category_code);
      }
      if (is_active !== undefined) {
        conditions.push('template.is_active = ?');
        values.push(is_active);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const [[count]] = await db.execute(
        `SELECT COUNT(*) AS total FROM notification_sms_templates template ${where}`,
        values
      );
      const total = Number(count.total);
      const [templates] = await db.execute(
        `SELECT template.id, template.code, template.category_code,
                category.name AS category_name, category.sms_enabled AS category_sms_enabled,
                template.recipient_type, recipient.name AS recipient_name,
                recipient.sms_enabled AS recipient_sms_enabled,
                template.name, template.body_template, template.is_active,
                template.is_system, template.created_by,
                COALESCE(user.full_name, user.user_name) AS created_by_name,
                template.created_at, template.updated_at
         FROM notification_sms_templates template
         INNER JOIN notification_email_categories category
           ON category.code = template.category_code
         INNER JOIN notification_sms_recipient_settings recipient
           ON recipient.code = template.recipient_type
         LEFT JOIN user_profiles user ON user.id = template.created_by
         ${where}
         ORDER BY template.name LIMIT ? OFFSET ?`,
        [...values, page_size, (page - 1) * page_size]
      );
      return res.json({
        templates: templates.map((template) => ({
          ...template,
          category_sms_enabled: Boolean(template.category_sms_enabled),
          recipient_sms_enabled: Boolean(template.recipient_sms_enabled),
          is_active: Boolean(template.is_active),
          is_system: Boolean(template.is_system)
        })),
        pagination: { page, page_size, total, total_pages: Math.ceil(total / page_size) }
      });
    } catch (error) {
      console.error(error);
      return sendError(res, 500, 'NOTIFICATION_SMS_TEMPLATE_LIST_FAILED',
        'Unable to list SMS templates.');
    }
  }
);

router.post(
  '/notification-sms-templates',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_NOTIFICATION_TEMPLATES),
  validate(schemas.notificationSmsTemplateCreate),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      await ensureReferences(connection, req.body.code, req.body.category_code,
        req.body.recipient_type);
      const id = uuidv4();
      await connection.execute(
        `INSERT INTO notification_sms_templates
         (id, code, category_code, recipient_type, name, body_template,
          is_active, is_system, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [id, req.body.code, req.body.category_code, req.body.recipient_type,
          req.body.name, req.body.body_template, req.body.is_active, req.user.id]
      );
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'NOTIFICATION_SMS_TEMPLATE_CREATED',
        resourceType: 'notification_sms_template',
        resourceId: id,
        requestId: req.requestId,
        metadata: { code: req.body.code, category_code: req.body.category_code,
          recipient_type: req.body.recipient_type }
      });
      await connection.commit();
      return res.status(201).json({ template: { id, ...req.body, is_system: false } });
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') {
        return sendError(res, 409, 'NOTIFICATION_SMS_TEMPLATE_EXISTS',
          'An SMS template already exists for this event code.');
      }
      if (error.status) return sendError(res, error.status, error.code, error.message);
      console.error(error);
      return sendError(res, 500, 'NOTIFICATION_SMS_TEMPLATE_CREATE_FAILED',
        'Unable to create SMS template.');
    } finally {
      connection.release();
    }
  }
);

router.patch(
  '/notification-sms-templates/:code',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_NOTIFICATION_TEMPLATES),
  validate(schemas.notificationSmsTemplateUpdate),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT id, code, category_code, recipient_type, is_system
         FROM notification_sms_templates WHERE code = ? FOR UPDATE`,
        [req.params.code]
      );
      const template = rows[0];
      if (!template) {
        await connection.rollback();
        return sendError(res, 404, 'NOTIFICATION_SMS_TEMPLATE_NOT_FOUND',
          'SMS template not found.');
      }
      if (template.is_system && req.user.role !== 'super_admin') {
        await connection.rollback();
        return sendError(res, 403, 'SYSTEM_NOTIFICATION_SMS_TEMPLATE_FORBIDDEN',
          'Only a super administrator can update system SMS templates.');
      }
      const categoryCode = req.body.category_code || template.category_code;
      const recipientType = req.body.recipient_type || template.recipient_type;
      if (req.body.category_code || req.body.recipient_type) {
        await ensureReferences(connection, template.code, categoryCode, recipientType);
      }
      const updates = [];
      const values = [];
      for (const field of ['category_code', 'recipient_type', 'name', 'body_template', 'is_active']) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = ?`);
          values.push(req.body[field]);
        }
      }
      await connection.execute(
        `UPDATE notification_sms_templates SET ${updates.join(', ')} WHERE id = ?`,
        [...values, template.id]
      );
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'NOTIFICATION_SMS_TEMPLATE_UPDATED',
        resourceType: 'notification_sms_template',
        resourceId: template.id,
        requestId: req.requestId,
        metadata: { code: template.code, changed_fields: Object.keys(req.body) }
      });
      await connection.commit();
      return res.json({ template: { code: template.code, ...req.body } });
    } catch (error) {
      await connection.rollback();
      if (error.status) return sendError(res, error.status, error.code, error.message);
      console.error(error);
      return sendError(res, 500, 'NOTIFICATION_SMS_TEMPLATE_UPDATE_FAILED',
        'Unable to update SMS template.');
    } finally {
      connection.release();
    }
  }
);

module.exports = router;
