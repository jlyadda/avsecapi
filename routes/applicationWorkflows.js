const express = require('express');
const db = require('../db');
const { authenticateToken, authorizePermission } = require('../middleware');
const { PERMISSIONS } = require('../permissions');
const { validate, schemas } = require('../validation');
const { findApplication } = require('./applicationHelpers');
const { recordAudit, sendError } = require('../audit');
const { createSystemNotification } = require('../services/notificationService');
const { executeVisitorWorkflowAction } = require('../services/workflowService');

const router = express.Router();

router.get(
  '/workflow-tasks/mine',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_WORKFLOW_TASKS),
  validate(schemas.workflowTaskList),
  async (req, res) => {
    try {
      const { search, page, page_size } = req.validatedQuery;
      const searchValue = `%${search}%`;
      const eligibility = `
        EXISTS (
          SELECT 1
          FROM workflow_stage_assignees assignee
          LEFT JOIN workflow_group_members member
            ON assignee.assignee_type = 'GROUP'
           AND member.group_id = assignee.assignee_value
           AND member.user_id = ?
          LEFT JOIN workflow_groups workflow_group
            ON workflow_group.id = member.group_id
          WHERE assignee.stage_id = stage.id
            AND (
              (assignee.assignee_type = 'ROLE' AND assignee.assignee_value = ?)
              OR (assignee.assignee_type = 'USER' AND assignee.assignee_value = ?)
              OR (assignee.assignee_type = 'GROUP' AND member.user_id IS NOT NULL
                  AND workflow_group.is_active = 1)
            )
        )
        AND (stage.allow_submitter_action = 1 OR application.submitted_by IS NULL
             OR application.submitted_by <> ?)
        AND (
          stage.require_different_actor = 0
          OR NOT EXISTS (
            SELECT 1 FROM application_workflow_actions previous_action
            WHERE previous_action.workflow_instance_id = instance.id
              AND previous_action.actor_id = ?
              AND previous_action.action = 'APPROVE'
          )
        )`;
      const searchCondition = search
        ? ` AND (
          application.application_number LIKE ? OR visitor.first_name LIKE ?
          OR visitor.last_name LIKE ? OR visitor.identity_number LIKE ?
          OR application.company_name LIKE ?
        )`
        : '';
      const baseParameters = [
        req.user.id,
        req.user.role,
        req.user.id,
        req.user.id,
        req.user.id
      ];
      const searchParameters = search ? Array(5).fill(searchValue) : [];
      const [[countRow]] = await db.execute(
        `SELECT COUNT(*) AS total
         FROM application_workflow_instances instance
         INNER JOIN application_stage_instances stage_instance
           ON stage_instance.workflow_instance_id = instance.id
          AND stage_instance.stage_id = instance.current_stage_id
         INNER JOIN application_workflow_stages stage ON stage.id = stage_instance.stage_id
         INNER JOIN visitor_applications application ON application.id = instance.application_id
         INNER JOIN all_visitors visitor ON visitor.id = application.visitor_id
         WHERE instance.status = 'ACTIVE' AND stage_instance.status = 'ACTIVE'
           AND ${eligibility}${searchCondition}`,
        [...baseParameters, ...searchParameters]
      );
      const total = Number(countRow.total);
      const offset = (page - 1) * page_size;
      const [tasks] = await db.execute(
        `SELECT application.id AS application_id,
                application.application_number, application.status AS application_status,
                application.company_name, application.visit_starts, application.visit_ends,
                visitor.first_name, visitor.last_name, visitor.other_names,
                visitor.identity_number,
                instance.id AS workflow_instance_id,
                stage.id AS stage_id, stage.code AS stage_code, stage.name AS stage_name,
                stage.sequence_number, stage.sla_hours,
                stage_instance.activated_at,
                CASE
                  WHEN stage.sla_hours IS NULL THEN NULL
                  ELSE DATE_ADD(stage_instance.activated_at, INTERVAL stage.sla_hours HOUR)
                END AS due_at
         FROM application_workflow_instances instance
         INNER JOIN application_stage_instances stage_instance
           ON stage_instance.workflow_instance_id = instance.id
          AND stage_instance.stage_id = instance.current_stage_id
         INNER JOIN application_workflow_stages stage ON stage.id = stage_instance.stage_id
         INNER JOIN visitor_applications application ON application.id = instance.application_id
         INNER JOIN all_visitors visitor ON visitor.id = application.visitor_id
         WHERE instance.status = 'ACTIVE' AND stage_instance.status = 'ACTIVE'
           AND ${eligibility}${searchCondition}
         ORDER BY stage_instance.activated_at
         LIMIT ? OFFSET ?`,
        [...baseParameters, ...searchParameters, page_size, offset]
      );
      return res.json({
        tasks,
        pagination: {
          page,
          page_size,
          total,
          total_pages: Math.ceil(total / page_size)
        }
      });
    } catch (error) {
      console.error(error);
      return sendError(res, 500, 'WORKFLOW_TASK_LIST_FAILED', 'Unable to list workflow tasks.');
    }
  }
);

router.get(
  '/visitor-applications/:reference/workflow',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_APPLICATIONS),
  validate(schemas.applicationReference),
  async (req, res) => {
    try {
      const application = await findApplication(db, req.params.reference);
      if (!application) {
        return sendError(res, 404, 'APPLICATION_NOT_FOUND', 'Application not found.');
      }
      const [instances] = await db.execute(
        `SELECT instance.id, instance.status, instance.started_at, instance.completed_at,
                version.version_number, workflow.id AS workflow_id,
                workflow.code AS workflow_code, workflow.name AS workflow_name
         FROM application_workflow_instances instance
         INNER JOIN application_workflow_versions version ON version.id = instance.version_id
         INNER JOIN application_workflows workflow ON workflow.id = version.workflow_id
         WHERE instance.application_id = ?`,
        [application.id]
      );
      const instance = instances[0];
      if (!instance) {
        return res.json({ workflow: null });
      }
      const [stages] = await db.execute(
        `SELECT stage.id, stage.sequence_number, stage.code, stage.name,
                stage.description, stage.approval_policy, stage.sla_hours,
                stage.captures_access_approval,
                stage_instance.status, stage_instance.activated_at,
                stage_instance.completed_at, stage_instance.notes,
                stage_instance.completed_by AS completed_by_id,
                COALESCE(user.full_name, user.user_name) AS completed_by
         FROM application_stage_instances stage_instance
         INNER JOIN application_workflow_stages stage ON stage.id = stage_instance.stage_id
         LEFT JOIN user_profiles user ON user.id = stage_instance.completed_by
         WHERE stage_instance.workflow_instance_id = ?
         ORDER BY stage.sequence_number`,
        [instance.id]
      );
      const [actions] = await db.execute(
        `SELECT action.id, action.action, action.notes, action.request_id,
                action.created_at, action.actor_id,
                COALESCE(user.full_name, user.user_name) AS actor_name,
                stage.code AS stage_code, stage.name AS stage_name
         FROM application_workflow_actions action
         INNER JOIN application_stage_instances stage_instance
           ON stage_instance.id = action.stage_instance_id
         INNER JOIN application_workflow_stages stage ON stage.id = stage_instance.stage_id
         INNER JOIN user_profiles user ON user.id = action.actor_id
         WHERE action.workflow_instance_id = ?
         ORDER BY action.created_at`,
        [instance.id]
      );
      const [approvedAreas] = await db.execute(
        `SELECT area.code, area.name, approved.approved_by AS approved_by_id,
                COALESCE(user.full_name, user.user_name) AS approved_by,
                approved.approved_at
         FROM application_approved_access_areas approved
         INNER JOIN access_areas area ON area.code = approved.area_code
         LEFT JOIN user_profiles user ON user.id = approved.approved_by
         WHERE approved.application_id = ?
         ORDER BY area.sort_order, area.name`,
        [application.id]
      );
      const [documentReviews] = await db.execute(
        `SELECT review.document_key, review.document_url, review.verdict, review.notes,
                review.reviewed_by AS reviewed_by_id,
                COALESCE(user.full_name, user.user_name) AS reviewed_by,
                review.reviewed_at
         FROM application_document_reviews review
         LEFT JOIN user_profiles user ON user.id = review.reviewed_by
         WHERE review.application_id = ?
         ORDER BY review.document_key`,
        [application.id]
      );
      return res.json({
        workflow: {
          ...instance,
          stages,
          actions,
          approved_visit_starts: application.approved_visit_starts,
          approved_visit_ends: application.approved_visit_ends,
          approved_areas_of_access: approvedAreas,
          document_reviews: documentReviews
        }
      });
    } catch (error) {
      console.error(error);
      return sendError(res, 500, 'WORKFLOW_LOAD_FAILED', 'Unable to load application workflow.');
    }
  }
);

router.post(
  '/visitor-applications/:reference/workflow/actions',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_WORKFLOW_TASKS),
  validate(schemas.visitorWorkflowAction),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const application = await findApplication(connection, req.params.reference, true);
      if (!application) {
        await connection.rollback();
        return sendError(res, 404, 'APPLICATION_NOT_FOUND', 'Application not found.');
      }
      const result = await executeVisitorWorkflowAction(connection, {
        application,
        user: req.user,
        action: req.body.action,
        notes: req.body.notes,
        approvedAreas: req.body.approved_areas_of_access,
        approvedVisitStarts: req.body.approved_visit_starts,
        approvedVisitEnds: req.body.approved_visit_ends,
        documentReviews: req.body.document_reviews,
        requestId: req.requestId
      });
      await recordAudit(connection, {
        actorId: req.user.id,
        action: `VISITOR_WORKFLOW_STAGE_${req.body.action}`,
        resourceType: 'visitor_application',
        resourceId: application.id,
        requestId: req.requestId,
        metadata: {
          application_number: application.application_number,
          stage: result.actedStage.code,
          resulting_status: result.status,
          approved_visit_starts: req.body.approved_visit_starts || null,
          approved_visit_ends: req.body.approved_visit_ends || null,
          approved_areas_of_access: req.body.approved_areas_of_access || null,
          document_review_summary: req.body.document_reviews
            ? req.body.document_reviews.reduce((summary, review) => ({
              ...summary,
              [review.verdict]: (summary[review.verdict] || 0) + 1
            }), {})
            : null
        }
      });
      if (result.completed) {
        await createSystemNotification(connection, {
          templateCode: 'VISITOR_WORKFLOW_COMPLETED',
          values: {
            reference: application.application_number,
            decision: result.status.toLowerCase()
          },
          requestId: req.requestId,
          resourceType: 'visitor_application',
          resourceId: application.id,
          targets: [
            { type: 'EXTERNAL_EMAIL', value: application.personal_email },
            { type: 'EXTERNAL_SMS', value: application.personal_phone }
          ],
          channels: ['EMAIL', 'SMS'],
          recipientType: 'VISITOR_APPLICANT',
          metadata: {
            application_number: application.application_number,
            decision: result.status
          }
        });
      }
      await connection.commit();
      const updatedApplication = await findApplication(db, application.id);
      return res.json({
        application: updatedApplication,
        workflow: {
          status: result.status,
          completed: result.completed,
          current_stage: result.completed ? null : {
            code: result.stage.code,
            name: result.stage.name
          }
        }
      });
    } catch (error) {
      await connection.rollback();
      if (error.status) {
        return res.status(error.status).json({
          error: error.message,
          code: error.code,
          expected_document_keys: error.expectedDocumentKeys
        });
      }
      console.error(error);
      return sendError(
        res,
        500,
        'WORKFLOW_ACTION_FAILED',
        'Unable to complete workflow action.'
      );
    } finally {
      connection.release();
    }
  }
);

module.exports = router;
