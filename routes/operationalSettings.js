const express = require('express');
const db = require('../db');
const { authenticateToken, authorizePermission } = require('../middleware');
const { PERMISSIONS } = require('../permissions');
const { validate, schemas } = require('../validation');
const { recordAudit, sendError } = require('../audit');

const router = express.Router();

router.get(
  '/operational-settings/pass-return',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_OPERATIONAL_SETTINGS),
  async (req, res) => {
    try {
      const [rows] = await db.execute(
        `SELECT max_hold_hours, updated_by, created_at, updated_at
         FROM pass_return_settings WHERE id = 1`
      );
      return res.json({ settings: rows[0] });
    } catch (error) {
      console.error(error);
      return sendError(res, 500, 'PASS_RETURN_SETTINGS_LOAD_FAILED',
        'Unable to load pass-return settings.');
    }
  }
);

router.patch(
  '/operational-settings/pass-return',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_OPERATIONAL_SETTINGS),
  validate(schemas.passReturnSettingsUpdate),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [[previous]] = await connection.execute(
        'SELECT max_hold_hours FROM pass_return_settings WHERE id = 1 FOR UPDATE'
      );
      await connection.execute(
        `UPDATE pass_return_settings SET max_hold_hours = ?, updated_by = ? WHERE id = 1`,
        [req.body.max_hold_hours, req.user.id]
      );
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'PASS_RETURN_SETTINGS_UPDATED',
        resourceType: 'pass_return_settings',
        resourceId: '1',
        requestId: req.requestId,
        metadata: {
          previous_max_hold_hours: Number(previous.max_hold_hours),
          max_hold_hours: req.body.max_hold_hours
        }
      });
      await connection.commit();
      return res.json({ settings: { max_hold_hours: req.body.max_hold_hours } });
    } catch (error) {
      await connection.rollback();
      console.error(error);
      return sendError(res, 500, 'PASS_RETURN_SETTINGS_UPDATE_FAILED',
        'Unable to update pass-return settings.');
    } finally {
      connection.release();
    }
  }
);

module.exports = router;
