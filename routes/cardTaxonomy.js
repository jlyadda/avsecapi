const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authenticateToken, authorizePermission } = require('../middleware');
const { PERMISSIONS } = require('../permissions');
const { validate, schemas } = require('../validation');
const { recordAudit, sendError } = require('../audit');

const router = express.Router();

const resources = {
  levels: {
    path: 'card-access-levels',
    table: 'card_access_levels',
    cardColumn: 'access_level',
    resourceType: 'card_access_level',
    responseKey: 'access_levels'
  },
  categories: {
    path: 'card-categories',
    table: 'card_categories',
    cardColumn: 'category',
    resourceType: 'card_category',
    responseKey: 'categories'
  }
};

const registerRoutes = (resource) => {
  router.get(
    `/${resource.path}`,
    authenticateToken,
    authorizePermission(PERMISSIONS.VIEW_CARDS),
    validate(schemas.taxonomyList),
    async (req, res) => {
      try {
        const activeClause = req.validatedQuery.include_inactive ? '' : 'WHERE is_active = 1';
        const [items] = await db.query(
          `SELECT id, code, name, description, sort_order, is_active, created_at, updated_at
           FROM ${resource.table}
           ${activeClause}
           ORDER BY sort_order, name`
        );
        return res.json({
          [resource.responseKey]: items.map((item) => ({
            ...item,
            is_active: Boolean(item.is_active)
          }))
        });
      } catch (error) {
        console.error(error);
        return sendError(
          res,
          500,
          'CARD_TAXONOMY_LIST_FAILED',
          'Unable to list card configuration values.'
        );
      }
    }
  );

  router.post(
    `/${resource.path}`,
    authenticateToken,
    authorizePermission(PERMISSIONS.MANAGE_CARD_INVENTORY),
    validate(schemas.taxonomyCreate),
    async (req, res) => {
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        const id = uuidv4();
        await connection.execute(
          `INSERT INTO ${resource.table}
           (id, code, name, description, sort_order, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            id,
            req.body.code,
            req.body.name,
            req.body.description || null,
            req.body.sort_order,
            req.user.id
          ]
        );
        await recordAudit(connection, {
          actorId: req.user.id,
          action: `${resource.resourceType.toUpperCase()}_CREATED`,
          resourceType: resource.resourceType,
          resourceId: id,
          requestId: req.requestId,
          metadata: { code: req.body.code, name: req.body.name }
        });
        await connection.commit();
        const [rows] = await db.query(
          `SELECT id, code, name, description, sort_order, is_active, created_at, updated_at
           FROM ${resource.table} WHERE id = ?`,
          [id]
        );
        return res.status(201).json({
          item: { ...rows[0], is_active: Boolean(rows[0].is_active) }
        });
      } catch (error) {
        await connection.rollback();
        if (error.code === 'ER_DUP_ENTRY') {
          return sendError(
            res,
            409,
            'CARD_TAXONOMY_CODE_EXISTS',
            'That card configuration code already exists.'
          );
        }
        console.error(error);
        return sendError(
          res,
          500,
          'CARD_TAXONOMY_CREATE_FAILED',
          'Unable to create card configuration value.'
        );
      } finally {
        connection.release();
      }
    }
  );

  router.patch(
    `/${resource.path}/:id`,
    authenticateToken,
    authorizePermission(PERMISSIONS.MANAGE_CARD_INVENTORY),
    validate(schemas.taxonomyUpdate),
    async (req, res) => {
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        const [rows] = await connection.query(
          `SELECT * FROM ${resource.table} WHERE id = ? FOR UPDATE`,
          [req.params.id]
        );
        const item = rows[0];
        if (!item) {
          await connection.rollback();
          return sendError(
            res,
            404,
            'CARD_TAXONOMY_NOT_FOUND',
            'Card configuration value not found.'
          );
        }
        if (req.body.is_active === false && item.is_active) {
          const [[usage]] = await connection.query(
            `SELECT COUNT(*) AS total
             FROM access_cards
             WHERE ${resource.cardColumn} = ? AND is_active = 1`,
            [item.code]
          );
          if (Number(usage.total) > 0) {
            await connection.rollback();
            return sendError(
              res,
              409,
              'CARD_TAXONOMY_IN_USE',
              'Deactivate or reclassify active cards before disabling this value.'
            );
          }
        }

        const updates = [];
        const parameters = [];
        for (const field of ['name', 'description', 'sort_order', 'is_active']) {
          if (req.body[field] !== undefined) {
            updates.push(`${field} = ?`);
            parameters.push(req.body[field]);
          }
        }
        parameters.push(item.id);
        await connection.execute(
          `UPDATE ${resource.table} SET ${updates.join(', ')} WHERE id = ?`,
          parameters
        );
        await recordAudit(connection, {
          actorId: req.user.id,
          action: `${resource.resourceType.toUpperCase()}_UPDATED`,
          resourceType: resource.resourceType,
          resourceId: item.id,
          requestId: req.requestId,
          metadata: { code: item.code, changed_fields: Object.keys(req.body) }
        });
        await connection.commit();
        const [updatedRows] = await db.query(
          `SELECT id, code, name, description, sort_order, is_active, created_at, updated_at
           FROM ${resource.table} WHERE id = ?`,
          [item.id]
        );
        return res.json({
          item: {
            ...updatedRows[0],
            is_active: Boolean(updatedRows[0].is_active)
          }
        });
      } catch (error) {
        await connection.rollback();
        console.error(error);
        return sendError(
          res,
          500,
          'CARD_TAXONOMY_UPDATE_FAILED',
          'Unable to update card configuration value.'
        );
      } finally {
        connection.release();
      }
    }
  );
};

Object.values(resources).forEach(registerRoutes);

module.exports = router;
