const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authenticateToken, authorizePermission } = require('../middleware');
const { PERMISSIONS } = require('../permissions');
const { validate, schemas } = require('../validation');
const { recordAudit, sendError } = require('../audit');

const router = express.Router();

const ensureActiveCategory = async (executor, categoryCode) => {
  const [categories] = await executor.execute(
    `SELECT code FROM notification_email_categories
     WHERE code = ? AND is_active = 1`,
    [categoryCode]
  );
  if (!categories[0]) {
    const error = new Error('Notification email category not found or inactive.');
    error.status = 422;
    error.code = 'NOTIFICATION_EMAIL_CATEGORY_INVALID';
    throw error;
  }
};

router.get(
  '/notification-email-templates',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_NOTIFICATION_TEMPLATES),
  validate(schemas.notificationTemplateList),
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
        `SELECT COUNT(*) AS total
         FROM notification_templates template ${where}`,
        values
      );
      const total = Number(count.total);
      const [templates] = await db.execute(
        `SELECT template.id, template.code, template.category_code,
                category.name AS category_name,
                category.email_enabled AS category_email_enabled,
                template.name, template.title_template, template.body_template,
                template.default_priority, template.is_active, template.is_system,
                template.created_by,
                COALESCE(user.full_name, user.user_name) AS created_by_name,
                template.created_at, template.updated_at
         FROM notification_templates template
         INNER JOIN notification_email_categories category
           ON category.code = template.category_code
         LEFT JOIN user_profiles user ON user.id = template.created_by
         ${where}
         ORDER BY template.name
         LIMIT ? OFFSET ?`,
        [...values, page_size, (page - 1) * page_size]
      );
      return res.json({
        templates: templates.map((template) => ({
          ...template,
          category_email_enabled: Boolean(template.category_email_enabled),
          is_active: Boolean(template.is_active),
          is_system: Boolean(template.is_system)
        })),
        pagination: {
          page,
          page_size,
          total,
          total_pages: Math.ceil(total / page_size)
        }
      });
    } catch (error) {
      console.error(error);
      return sendError(
        res,
        500,
        'NOTIFICATION_TEMPLATE_LIST_FAILED',
        'Unable to list notification email templates.'
      );
    }
  }
);

router.post(
  '/notification-email-templates',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_NOTIFICATION_TEMPLATES),
  validate(schemas.notificationTemplateCreate),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      await ensureActiveCategory(connection, req.body.category_code);
      const id = uuidv4();
      await connection.execute(
        `INSERT INTO notification_templates
         (id, code, category_code, name, title_template, body_template,
          default_priority, is_active, is_system, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [
          id,
          req.body.code,
          req.body.category_code,
          req.body.name,
          req.body.title_template,
          req.body.body_template,
          req.body.default_priority,
          req.body.is_active,
          req.user.id
        ]
      );
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'NOTIFICATION_EMAIL_TEMPLATE_CREATED',
        resourceType: 'notification_template',
        resourceId: id,
        requestId: req.requestId,
        metadata: {
          code: req.body.code,
          category_code: req.body.category_code
        }
      });
      await connection.commit();
      return res.status(201).json({
        template: {
          id,
          ...req.body,
          is_system: false,
          created_by: req.user.id
        }
      });
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') {
        return sendError(
          res,
          409,
          'NOTIFICATION_TEMPLATE_EXISTS',
          'A notification template with this code already exists.'
        );
      }
      if (error.status) {
        return sendError(res, error.status, error.code, error.message);
      }
      console.error(error);
      return sendError(
        res,
        500,
        'NOTIFICATION_TEMPLATE_CREATE_FAILED',
        'Unable to create notification email template.'
      );
    } finally {
      connection.release();
    }
  }
);

router.patch(
  '/notification-email-templates/:code',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_NOTIFICATION_TEMPLATES),
  validate(schemas.notificationTemplateUpdate),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [templates] = await connection.execute(
        `SELECT id, code, is_system
         FROM notification_templates WHERE code = ? FOR UPDATE`,
        [req.params.code]
      );
      const template = templates[0];
      if (!template) {
        await connection.rollback();
        return sendError(
          res,
          404,
          'NOTIFICATION_TEMPLATE_NOT_FOUND',
          'Notification email template not found.'
        );
      }
      if (template.is_system && req.user.role !== 'super_admin') {
        await connection.rollback();
        return sendError(
          res,
          403,
          'SYSTEM_NOTIFICATION_TEMPLATE_FORBIDDEN',
          'Only a super administrator can update system templates.'
        );
      }
      if (req.body.category_code) {
        await ensureActiveCategory(connection, req.body.category_code);
      }
      const updates = [];
      const values = [];
      for (const field of [
        'category_code',
        'name',
        'title_template',
        'body_template',
        'default_priority',
        'is_active'
      ]) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = ?`);
          values.push(req.body[field]);
        }
      }
      await connection.execute(
        `UPDATE notification_templates SET ${updates.join(', ')} WHERE id = ?`,
        [...values, template.id]
      );
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'NOTIFICATION_EMAIL_TEMPLATE_UPDATED',
        resourceType: 'notification_template',
        resourceId: template.id,
        requestId: req.requestId,
        metadata: {
          code: template.code,
          changed_fields: Object.keys(req.body)
        }
      });
      await connection.commit();
      return res.json({
        template: {
          code: template.code,
          ...req.body
        },
        message: 'Notification email template updated.'
      });
    } catch (error) {
      await connection.rollback();
      if (error.status) {
        return sendError(res, error.status, error.code, error.message);
      }
      console.error(error);
      return sendError(
        res,
        500,
        'NOTIFICATION_TEMPLATE_UPDATE_FAILED',
        'Unable to update notification email template.'
      );
    } finally {
      connection.release();
    }
  }
);

module.exports = router;
