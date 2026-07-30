const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authenticateToken, authorizePermission } = require('../middleware');
const { PERMISSIONS } = require('../permissions');
const { validate, schemas } = require('../validation');
const { recordAudit, sendError } = require('../audit');

const router = express.Router();

const replaceGroupMembers = async (connection, groupId, userIds, actorId) => {
  const uniqueIds = [...new Set(userIds)];
  if (uniqueIds.length > 0) {
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const [users] = await connection.query(
      `SELECT id FROM user_profiles
       WHERE id IN (${placeholders}) AND is_active = 1`,
      uniqueIds
    );
    if (users.length !== uniqueIds.length) {
      const error = new Error('One or more users are invalid or inactive.');
      error.status = 422;
      throw error;
    }
  }
  await connection.execute(
    'DELETE FROM workflow_group_members WHERE group_id = ?',
    [groupId]
  );
  for (const userId of uniqueIds) {
    await connection.execute(
      `INSERT INTO workflow_group_members (group_id, user_id, added_by)
       VALUES (?, ?, ?)`,
      [groupId, userId, actorId]
    );
  }
};

router.get(
  '/workflow-groups',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_APPLICATION_WORKFLOWS),
  async (req, res) => {
    try {
      const [groups] = await db.query(
        `SELECT workflow_group.id, workflow_group.code, workflow_group.name,
                workflow_group.description, workflow_group.is_active,
                workflow_group.created_at, workflow_group.updated_at,
                COUNT(member.user_id) AS member_count
         FROM workflow_groups workflow_group
         LEFT JOIN workflow_group_members member
           ON member.group_id = workflow_group.id
         GROUP BY workflow_group.id
         ORDER BY workflow_group.name`
      );
      const [members] = await db.query(
        `SELECT member.group_id, user.id, user.user_name, user.full_name,
                user.email, user.user_role AS role
         FROM workflow_group_members member
         INNER JOIN user_profiles user ON user.id = member.user_id
         ORDER BY COALESCE(user.full_name, user.user_name)`
      );
      return res.json({
        groups: groups.map((group) => ({
          ...group,
          is_active: Boolean(group.is_active),
          member_count: Number(group.member_count),
          members: members.filter((member) => member.group_id === group.id)
            .map(({ group_id, ...member }) => member)
        }))
      });
    } catch (error) {
      console.error(error);
      return sendError(res, 500, 'WORKFLOW_GROUP_LIST_FAILED', 'Unable to list workflow groups.');
    }
  }
);

router.post(
  '/workflow-groups',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_APPLICATION_WORKFLOWS),
  validate(schemas.workflowGroupCreate),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const groupId = uuidv4();
      await connection.execute(
        `INSERT INTO workflow_groups
         (id, code, name, description, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [
          groupId,
          req.body.code,
          req.body.name,
          req.body.description || null,
          req.user.id
        ]
      );
      await replaceGroupMembers(connection, groupId, req.body.user_ids, req.user.id);
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'WORKFLOW_GROUP_CREATED',
        resourceType: 'workflow_group',
        resourceId: groupId,
        requestId: req.requestId,
        metadata: { code: req.body.code, member_count: new Set(req.body.user_ids).size }
      });
      await connection.commit();
      return res.status(201).json({
        group: {
          id: groupId,
          code: req.body.code,
          name: req.body.name,
          description: req.body.description || null,
          is_active: true,
          user_ids: [...new Set(req.body.user_ids)]
        }
      });
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') {
        return sendError(res, 409, 'WORKFLOW_GROUP_EXISTS', 'Workflow group code or name exists.');
      }
      if (error.status) {
        return sendError(res, error.status, 'WORKFLOW_GROUP_MEMBERS_INVALID', error.message);
      }
      console.error(error);
      return sendError(res, 500, 'WORKFLOW_GROUP_CREATE_FAILED', 'Unable to create workflow group.');
    } finally {
      connection.release();
    }
  }
);

router.patch(
  '/workflow-groups/:id',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_APPLICATION_WORKFLOWS),
  validate(schemas.workflowGroupUpdate),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const updates = [];
      const values = [];
      for (const field of ['name', 'description', 'is_active']) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = ?`);
          values.push(req.body[field]);
        }
      }
      const [result] = await connection.execute(
        `UPDATE workflow_groups SET ${updates.join(', ')} WHERE id = ?`,
        [...values, req.params.id]
      );
      if (result.affectedRows === 0) {
        await connection.rollback();
        return sendError(res, 404, 'WORKFLOW_GROUP_NOT_FOUND', 'Workflow group not found.');
      }
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'WORKFLOW_GROUP_UPDATED',
        resourceType: 'workflow_group',
        resourceId: req.params.id,
        requestId: req.requestId,
        metadata: { changed_fields: Object.keys(req.body) }
      });
      await connection.commit();
      return res.json({ message: 'Workflow group updated.' });
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') {
        return sendError(res, 409, 'WORKFLOW_GROUP_EXISTS', 'Workflow group name exists.');
      }
      console.error(error);
      return sendError(res, 500, 'WORKFLOW_GROUP_UPDATE_FAILED', 'Unable to update workflow group.');
    } finally {
      connection.release();
    }
  }
);

router.put(
  '/workflow-groups/:id/members',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_APPLICATION_WORKFLOWS),
  validate(schemas.workflowGroupMembers),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [groups] = await connection.execute(
        'SELECT id FROM workflow_groups WHERE id = ? FOR UPDATE',
        [req.params.id]
      );
      if (!groups[0]) {
        await connection.rollback();
        return sendError(res, 404, 'WORKFLOW_GROUP_NOT_FOUND', 'Workflow group not found.');
      }
      await replaceGroupMembers(connection, req.params.id, req.body.user_ids, req.user.id);
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'WORKFLOW_GROUP_MEMBERS_REPLACED',
        resourceType: 'workflow_group',
        resourceId: req.params.id,
        requestId: req.requestId,
        metadata: { member_count: new Set(req.body.user_ids).size }
      });
      await connection.commit();
      return res.json({ message: 'Workflow group members updated.' });
    } catch (error) {
      await connection.rollback();
      if (error.status) {
        return sendError(res, error.status, 'WORKFLOW_GROUP_MEMBERS_INVALID', error.message);
      }
      console.error(error);
      return sendError(
        res,
        500,
        'WORKFLOW_GROUP_MEMBERS_UPDATE_FAILED',
        'Unable to update workflow group members.'
      );
    } finally {
      connection.release();
    }
  }
);

router.get(
  '/application-workflows',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_APPLICATION_WORKFLOWS),
  async (req, res) => {
    try {
      const [workflows] = await db.query(
        `SELECT workflow.id, workflow.code, workflow.name, workflow.description,
                workflow.application_type, workflow.active_version_id,
                workflow.is_active, workflow.created_at, workflow.updated_at,
                version.version_number AS active_version_number
         FROM application_workflows workflow
         LEFT JOIN application_workflow_versions version
           ON version.id = workflow.active_version_id
         ORDER BY workflow.name`
      );
      const [versions] = await db.query(
        `SELECT id, workflow_id, version_number, status, activated_at, created_at
         FROM application_workflow_versions
         ORDER BY workflow_id, version_number DESC`
      );
      return res.json({
        workflows: workflows.map((workflow) => ({
          ...workflow,
          is_active: Boolean(workflow.is_active),
          versions: versions.filter((version) => version.workflow_id === workflow.id)
        }))
      });
    } catch (error) {
      console.error(error);
      return sendError(res, 500, 'WORKFLOW_LIST_FAILED', 'Unable to list workflows.');
    }
  }
);

router.post(
  '/application-workflows',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_APPLICATION_WORKFLOWS),
  validate(schemas.applicationWorkflowCreate),
  async (req, res) => {
    const workflowId = uuidv4();
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO application_workflows
         (id, code, name, description, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [
          workflowId,
          req.body.code,
          req.body.name,
          req.body.description || null,
          req.user.id
        ]
      );
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'APPLICATION_WORKFLOW_CREATED',
        resourceType: 'application_workflow',
        resourceId: workflowId,
        requestId: req.requestId,
        metadata: { code: req.body.code }
      });
      await connection.commit();
      return res.status(201).json({
        workflow: {
          id: workflowId,
          ...req.body,
          application_type: 'VISITOR',
          active_version_id: null,
          is_active: true
        }
      });
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') {
        return sendError(res, 409, 'WORKFLOW_EXISTS', 'Workflow code already exists.');
      }
      console.error(error);
      return sendError(res, 500, 'WORKFLOW_CREATE_FAILED', 'Unable to create workflow.');
    } finally {
      connection.release();
    }
  }
);

router.patch(
  '/application-workflows/:id',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_APPLICATION_WORKFLOWS),
  validate(schemas.applicationWorkflowUpdate),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const updates = [];
      const values = [];
      for (const field of ['name', 'description', 'is_active']) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = ?`);
          values.push(req.body[field]);
        }
      }
      const [result] = await connection.execute(
        `UPDATE application_workflows SET ${updates.join(', ')} WHERE id = ?`,
        [...values, req.params.id]
      );
      if (result.affectedRows === 0) {
        await connection.rollback();
        return sendError(res, 404, 'WORKFLOW_NOT_FOUND', 'Workflow not found.');
      }
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'APPLICATION_WORKFLOW_UPDATED',
        resourceType: 'application_workflow',
        resourceId: req.params.id,
        requestId: req.requestId,
        metadata: { changed_fields: Object.keys(req.body) }
      });
      await connection.commit();
      return res.json({ message: 'Workflow updated.' });
    } catch (error) {
      await connection.rollback();
      console.error(error);
      return sendError(res, 500, 'WORKFLOW_UPDATE_FAILED', 'Unable to update workflow.');
    } finally {
      connection.release();
    }
  }
);

router.post(
  '/application-workflows/:id/versions',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_APPLICATION_WORKFLOWS),
  validate(schemas.applicationWorkflowVersionCreate),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [workflows] = await connection.execute(
        'SELECT id FROM application_workflows WHERE id = ? FOR UPDATE',
        [req.params.id]
      );
      if (!workflows[0]) {
        await connection.rollback();
        return sendError(res, 404, 'WORKFLOW_NOT_FOUND', 'Workflow not found.');
      }

      const groupIds = [...new Set(req.body.stages.flatMap((stage) => (
        stage.assignees.filter((assignee) => assignee.type === 'GROUP')
          .map((assignee) => assignee.value)
      )))];
      const userIds = [...new Set(req.body.stages.flatMap((stage) => (
        stage.assignees.filter((assignee) => assignee.type === 'USER')
          .map((assignee) => assignee.value)
      )))];
      if (groupIds.length > 0) {
        const [groups] = await connection.query(
          `SELECT id FROM workflow_groups
           WHERE id IN (${groupIds.map(() => '?').join(', ')}) AND is_active = 1`,
          groupIds
        );
        if (groups.length !== groupIds.length) {
          throw Object.assign(new Error('One or more workflow groups are invalid or inactive.'), {
            status: 422
          });
        }
      }
      if (userIds.length > 0) {
        const [users] = await connection.query(
          `SELECT id FROM user_profiles
           WHERE id IN (${userIds.map(() => '?').join(', ')}) AND is_active = 1`,
          userIds
        );
        if (users.length !== userIds.length) {
          throw Object.assign(new Error('One or more assigned users are invalid or inactive.'), {
            status: 422
          });
        }
      }

      const [[versionRow]] = await connection.execute(
        `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
         FROM application_workflow_versions WHERE workflow_id = ?`,
        [req.params.id]
      );
      const versionId = uuidv4();
      await connection.execute(
        `INSERT INTO application_workflow_versions
         (id, workflow_id, version_number, created_by)
         VALUES (?, ?, ?, ?)`,
        [versionId, req.params.id, versionRow.next_version, req.user.id]
      );
      for (const [index, stage] of req.body.stages.entries()) {
        const stageId = uuidv4();
        await connection.execute(
          `INSERT INTO application_workflow_stages
           (id, version_id, sequence_number, code, name, description,
            allow_submitter_action, require_different_actor, sla_hours)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            stageId,
            versionId,
            index + 1,
            stage.code,
            stage.name,
            stage.description || null,
            stage.allow_submitter_action,
            stage.require_different_actor,
            stage.sla_hours || null
          ]
        );
        for (const assignee of stage.assignees) {
          await connection.execute(
            `INSERT INTO workflow_stage_assignees
             (id, stage_id, assignee_type, assignee_value)
             VALUES (?, ?, ?, ?)`,
            [uuidv4(), stageId, assignee.type, assignee.value]
          );
        }
      }
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'APPLICATION_WORKFLOW_VERSION_CREATED',
        resourceType: 'application_workflow',
        resourceId: req.params.id,
        requestId: req.requestId,
        metadata: {
          version_id: versionId,
          version_number: Number(versionRow.next_version),
          stage_count: req.body.stages.length
        }
      });
      await connection.commit();
      return res.status(201).json({
        version: {
          id: versionId,
          workflow_id: req.params.id,
          version_number: Number(versionRow.next_version),
          status: 'DRAFT',
          stages: req.body.stages
        }
      });
    } catch (error) {
      await connection.rollback();
      if (error.status) {
        return sendError(res, error.status, 'WORKFLOW_ASSIGNEES_INVALID', error.message);
      }
      console.error(error);
      return sendError(
        res,
        500,
        'WORKFLOW_VERSION_CREATE_FAILED',
        'Unable to create workflow version.'
      );
    } finally {
      connection.release();
    }
  }
);

router.post(
  '/application-workflows/:id/versions/:versionId/activate',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_APPLICATION_WORKFLOWS),
  validate(schemas.applicationWorkflowVersionId),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [versions] = await connection.execute(
        `SELECT version.id, version.status
         FROM application_workflow_versions version
         INNER JOIN application_workflows workflow ON workflow.id = version.workflow_id
         WHERE version.id = ? AND workflow.id = ?
         FOR UPDATE`,
        [req.params.versionId, req.params.id]
      );
      const version = versions[0];
      if (!version) {
        await connection.rollback();
        return sendError(res, 404, 'WORKFLOW_VERSION_NOT_FOUND', 'Workflow version not found.');
      }
      if (version.status !== 'DRAFT') {
        await connection.rollback();
        return sendError(
          res,
          409,
          'WORKFLOW_VERSION_IMMUTABLE',
          'Only a draft workflow version can be activated.'
        );
      }
      const [[stageCount]] = await connection.execute(
        `SELECT COUNT(*) AS total
         FROM application_workflow_stages stage
         WHERE stage.version_id = ?
           AND EXISTS (
             SELECT 1 FROM workflow_stage_assignees assignee
             WHERE assignee.stage_id = stage.id
           )`,
        [version.id]
      );
      if (Number(stageCount.total) === 0) {
        await connection.rollback();
        return sendError(res, 422, 'WORKFLOW_VERSION_EMPTY', 'Workflow version has no valid stages.');
      }

      await connection.execute(
        `UPDATE application_workflow_versions version
         INNER JOIN application_workflows workflow ON workflow.id = version.workflow_id
         SET version.status = 'RETIRED'
         WHERE workflow.application_type = 'VISITOR' AND version.status = 'ACTIVE'`
      );
      await connection.execute(
        `UPDATE application_workflows
         SET active_version_id = NULL
         WHERE application_type = 'VISITOR'`
      );
      await connection.execute(
        `UPDATE application_workflow_versions
         SET status = 'ACTIVE', activated_by = ?, activated_at = NOW(3)
         WHERE id = ?`,
        [req.user.id, version.id]
      );
      await connection.execute(
        `UPDATE application_workflows
         SET active_version_id = ?, is_active = 1 WHERE id = ?`,
        [version.id, req.params.id]
      );
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'APPLICATION_WORKFLOW_VERSION_ACTIVATED',
        resourceType: 'application_workflow',
        resourceId: req.params.id,
        requestId: req.requestId,
        metadata: { version_id: version.id }
      });
      await connection.commit();
      return res.json({ message: 'Workflow version activated.', version_id: version.id });
    } catch (error) {
      await connection.rollback();
      console.error(error);
      return sendError(
        res,
        500,
        'WORKFLOW_VERSION_ACTIVATION_FAILED',
        'Unable to activate workflow version.'
      );
    } finally {
      connection.release();
    }
  }
);

module.exports = router;
