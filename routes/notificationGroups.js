const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authenticateToken, authorizePermission } = require('../middleware');
const { PERMISSIONS } = require('../permissions');
const { validate, schemas } = require('../validation');
const { recordAudit, sendError } = require('../audit');

const router = express.Router();

const replaceMembers = async (connection, groupId, userIds, actor) => {
  if (userIds.length > 0) {
    const placeholders = userIds.map(() => '?').join(', ');
    const [users] = await connection.query(
      `SELECT id, user_role FROM user_profiles
       WHERE id IN (${placeholders}) AND is_active = 1`,
      userIds
    );
    if (users.length !== new Set(userIds).size) {
      const error = new Error('One or more users are invalid or inactive.');
      error.status = 422;
      throw error;
    }
    if (
      actor.role === 'admin'
      && users.some((user) => ['admin', 'super_admin'].includes(user.user_role))
    ) {
      const error = new Error('Administrators cannot add administrator roles to groups.');
      error.status = 403;
      throw error;
    }
  }
  await connection.execute(
    'DELETE FROM notification_group_members WHERE group_id = ?',
    [groupId]
  );
  for (const userId of new Set(userIds)) {
    await connection.execute(
      `INSERT INTO notification_group_members (group_id, user_id, added_by)
       VALUES (?, ?, ?)`,
      [groupId, userId, actor.id]
    );
  }
};

router.get(
  '/notification-groups',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_NOTIFICATION_GROUPS),
  async (req, res) => {
    try {
      const [groups] = await db.query(
        `SELECT notification_group.id, notification_group.name,
                notification_group.description, notification_group.is_active,
                COUNT(member.user_id) AS member_count,
                notification_group.created_at, notification_group.updated_at
         FROM notification_groups notification_group
         LEFT JOIN notification_group_members member
           ON member.group_id = notification_group.id
         GROUP BY notification_group.id
         ORDER BY notification_group.name`
      );
      return res.json({
        groups: groups.map((group) => ({
          ...group,
          is_active: Boolean(group.is_active),
          member_count: Number(group.member_count)
        }))
      });
    } catch (error) {
      console.error(error);
      return sendError(res, 500, 'NOTIFICATION_GROUP_LIST_FAILED', 'Unable to list groups.');
    }
  }
);

router.post(
  '/notification-groups',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_NOTIFICATION_GROUPS),
  validate(schemas.notificationGroupCreate),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const id = uuidv4();
      await connection.execute(
        `INSERT INTO notification_groups
         (id, name, description, created_by)
         VALUES (?, ?, ?, ?)`,
        [id, req.body.name, req.body.description || null, req.user.id]
      );
      await replaceMembers(connection, id, req.body.user_ids, req.user);
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'NOTIFICATION_GROUP_CREATED',
        resourceType: 'notification_group',
        resourceId: id,
        requestId: req.requestId,
        metadata: { member_count: new Set(req.body.user_ids).size }
      });
      await connection.commit();
      return res.status(201).json({ group: { id, ...req.body, is_active: true } });
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') {
        return sendError(res, 409, 'NOTIFICATION_GROUP_EXISTS', 'Group name already exists.');
      }
      if (error.status) {
        return sendError(res, error.status, 'NOTIFICATION_GROUP_MEMBERS_INVALID', error.message);
      }
      console.error(error);
      return sendError(res, 500, 'NOTIFICATION_GROUP_CREATE_FAILED', 'Unable to create group.');
    } finally {
      connection.release();
    }
  }
);

router.patch(
  '/notification-groups/:id',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_NOTIFICATION_GROUPS),
  validate(schemas.notificationGroupUpdate),
  async (req, res) => {
    try {
      const updates = [];
      const parameters = [];
      for (const field of ['name', 'description', 'is_active']) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = ?`);
          parameters.push(req.body[field]);
        }
      }
      parameters.push(req.params.id);
      const [result] = await db.execute(
        `UPDATE notification_groups SET ${updates.join(', ')} WHERE id = ?`,
        parameters
      );
      if (result.affectedRows === 0) {
        return sendError(res, 404, 'NOTIFICATION_GROUP_NOT_FOUND', 'Group not found.');
      }
      return res.json({ message: 'Notification group updated.' });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        return sendError(res, 409, 'NOTIFICATION_GROUP_EXISTS', 'Group name already exists.');
      }
      console.error(error);
      return sendError(res, 500, 'NOTIFICATION_GROUP_UPDATE_FAILED', 'Unable to update group.');
    }
  }
);

router.put(
  '/notification-groups/:id/members',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_NOTIFICATION_GROUPS),
  validate(schemas.notificationGroupMembers),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [groups] = await connection.execute(
        'SELECT id FROM notification_groups WHERE id = ? FOR UPDATE',
        [req.params.id]
      );
      if (!groups[0]) {
        await connection.rollback();
        return sendError(res, 404, 'NOTIFICATION_GROUP_NOT_FOUND', 'Group not found.');
      }
      await replaceMembers(connection, req.params.id, req.body.user_ids, req.user);
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'NOTIFICATION_GROUP_MEMBERS_REPLACED',
        resourceType: 'notification_group',
        resourceId: req.params.id,
        requestId: req.requestId,
        metadata: { member_count: new Set(req.body.user_ids).size }
      });
      await connection.commit();
      return res.json({ message: 'Notification group members updated.' });
    } catch (error) {
      await connection.rollback();
      if (error.status) {
        return sendError(res, error.status, 'NOTIFICATION_GROUP_MEMBERS_INVALID', error.message);
      }
      console.error(error);
      return sendError(
        res,
        500,
        'NOTIFICATION_GROUP_MEMBERS_UPDATE_FAILED',
        'Unable to update group members.'
      );
    } finally {
      connection.release();
    }
  }
);

module.exports = router;
