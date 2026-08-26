const express = require('express');
const db = require('../db');
const { authenticateToken, authorizePermission } = require('../middleware');
const { PERMISSIONS } = require('../permissions');
const { validate, schemas } = require('../validation');
const { recordAudit, sendError } = require('../audit');

const router = express.Router();

router.get(
  '/access-areas',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_CARDS),
  validate(schemas.accessAreaList),
  async (req, res) => {
    try {
      const where = req.validatedQuery.include_inactive ? '' : 'WHERE is_active = 1';
      const [areas] = await db.query(
        `SELECT code, name, description, sort_order, is_active, created_at, updated_at
         FROM access_areas ${where} ORDER BY sort_order, name`
      );
      return res.json({
        access_areas: areas.map((area) => ({
          ...area,
          is_active: Boolean(area.is_active)
        }))
      });
    } catch (error) {
      console.error(error);
      return sendError(res, 500, 'ACCESS_AREA_LIST_FAILED', 'Unable to list access areas.');
    }
  }
);

router.post(
  '/access-areas',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_CARD_INVENTORY),
  validate(schemas.accessAreaCreate),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO access_areas
         (code, name, description, sort_order, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [
          req.body.code,
          req.body.name,
          req.body.description || null,
          req.body.sort_order,
          req.user.id
        ]
      );
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'ACCESS_AREA_CREATED',
        resourceType: 'access_area',
        resourceId: req.body.code,
        requestId: req.requestId,
        metadata: { name: req.body.name }
      });
      await connection.commit();
      return res.status(201).json({
        access_area: { ...req.body, description: req.body.description || null, is_active: true }
      });
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') {
        return sendError(res, 409, 'ACCESS_AREA_EXISTS', 'Access area code or name exists.');
      }
      console.error(error);
      return sendError(res, 500, 'ACCESS_AREA_CREATE_FAILED', 'Unable to create access area.');
    } finally {
      connection.release();
    }
  }
);

router.patch(
  '/access-areas/:code',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_CARD_INVENTORY),
  validate(schemas.accessAreaUpdate),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT code, is_active FROM access_areas WHERE code = ? FOR UPDATE',
        [req.params.code]
      );
      if (!rows[0]) {
        await connection.rollback();
        return sendError(res, 404, 'ACCESS_AREA_NOT_FOUND', 'Access area not found.');
      }
      if (req.body.is_active === false && rows[0].is_active) {
        const [[usage]] = await connection.execute(
          `SELECT COUNT(*) AS total
           FROM application_approved_access_areas approved
           INNER JOIN visitors visitor
             ON visitor.application_id = approved.application_id
           WHERE approved.area_code = ?
             AND visitor.status IN ('PENDING_VALIDITY','ELIGIBLE','CHECKED_IN','CHECKED_OUT')`,
          [req.params.code]
        );
        if (Number(usage.total) > 0) {
          await connection.rollback();
          return sendError(
            res,
            409,
            'ACCESS_AREA_IN_USE',
            'This area is assigned to an active approved visitor.'
          );
        }
      }
      const updates = [];
      const values = [];
      for (const field of ['name', 'description', 'sort_order', 'is_active']) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = ?`);
          values.push(req.body[field]);
        }
      }
      await connection.execute(
        `UPDATE access_areas SET ${updates.join(', ')} WHERE code = ?`,
        [...values, req.params.code]
      );
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'ACCESS_AREA_UPDATED',
        resourceType: 'access_area',
        resourceId: req.params.code,
        requestId: req.requestId,
        metadata: { changed_fields: Object.keys(req.body) }
      });
      await connection.commit();
      return res.json({ message: 'Access area updated.' });
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') {
        return sendError(res, 409, 'ACCESS_AREA_EXISTS', 'Access area name exists.');
      }
      console.error(error);
      return sendError(res, 500, 'ACCESS_AREA_UPDATE_FAILED', 'Unable to update access area.');
    } finally {
      connection.release();
    }
  }
);

router.get(
  '/card-access-levels/:code/areas',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_CARDS),
  validate(schemas.accessLevelArea),
  async (req, res) => {
    try {
      const [levels] = await db.execute(
        'SELECT code, name, is_active FROM card_access_levels WHERE code = ?',
        [req.params.code]
      );
      if (!levels[0]) {
        return sendError(res, 404, 'CARD_ACCESS_LEVEL_NOT_FOUND', 'Access level not found.');
      }
      const [areas] = await db.execute(
        `SELECT area.code, area.name, area.description, area.is_active
         FROM card_access_level_areas mapping
         INNER JOIN access_areas area ON area.code = mapping.area_code
         WHERE mapping.access_level_code = ?
         ORDER BY area.sort_order, area.name`,
        [req.params.code]
      );
      return res.json({
        access_level: { ...levels[0], is_active: Boolean(levels[0].is_active) },
        access_areas: areas.map((area) => ({ ...area, is_active: Boolean(area.is_active) }))
      });
    } catch (error) {
      console.error(error);
      return sendError(
        res,
        500,
        'CARD_ACCESS_LEVEL_AREAS_LOAD_FAILED',
        'Unable to load access-level areas.'
      );
    }
  }
);

router.put(
  '/card-access-levels/:code/areas',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_CARD_INVENTORY),
  validate(schemas.accessLevelAreaUpdate),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [levels] = await connection.execute(
        'SELECT code FROM card_access_levels WHERE code = ? FOR UPDATE',
        [req.params.code]
      );
      if (!levels[0]) {
        await connection.rollback();
        return sendError(res, 404, 'CARD_ACCESS_LEVEL_NOT_FOUND', 'Access level not found.');
      }
      const placeholders = req.body.area_codes.map(() => '?').join(', ');
      const [areas] = await connection.query(
        `SELECT code FROM access_areas
         WHERE code IN (${placeholders}) AND is_active = 1`,
        req.body.area_codes
      );
      if (areas.length !== req.body.area_codes.length) {
        await connection.rollback();
        return sendError(
          res,
          422,
          'CARD_ACCESS_LEVEL_AREAS_INVALID',
          'One or more access areas are invalid or inactive.'
        );
      }
      await connection.execute(
        'DELETE FROM card_access_level_areas WHERE access_level_code = ?',
        [req.params.code]
      );
      for (const areaCode of req.body.area_codes) {
        await connection.execute(
          `INSERT INTO card_access_level_areas
           (access_level_code, area_code, assigned_by)
           VALUES (?, ?, ?)`,
          [req.params.code, areaCode, req.user.id]
        );
      }
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'CARD_ACCESS_LEVEL_AREAS_REPLACED',
        resourceType: 'card_access_level',
        resourceId: req.params.code,
        requestId: req.requestId,
        metadata: { area_codes: req.body.area_codes }
      });
      await connection.commit();
      return res.json({
        access_level_code: req.params.code,
        area_codes: req.body.area_codes,
        message: 'Card access-level areas updated.'
      });
    } catch (error) {
      await connection.rollback();
      console.error(error);
      return sendError(
        res,
        500,
        'CARD_ACCESS_LEVEL_AREAS_UPDATE_FAILED',
        'Unable to update access-level areas.'
      );
    } finally {
      connection.release();
    }
  }
);

module.exports = router;
