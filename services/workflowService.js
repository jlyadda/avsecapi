const { v4: uuidv4 } = require('uuid');
const { createSystemNotification } = require('./notificationService');
const { promoteApprovedVisitor } = require('./approvedVisitorService');
const { validateDocumentReviews } = require('./documentReviewService');

const workflowError = (status, code, message) => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
};

const toDateOnly = (value) => {
  if (typeof value === 'string') return value.slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getNotificationTargets = async (executor, stageId) => {
  const [assignees] = await executor.execute(
    `SELECT assignee_type, assignee_value
     FROM workflow_stage_assignees
     WHERE stage_id = ?`,
    [stageId]
  );
  const targets = [];
  for (const assignee of assignees) {
    if (assignee.assignee_type === 'ROLE') {
      targets.push({ type: 'ROLE', value: assignee.assignee_value });
    } else if (assignee.assignee_type === 'USER') {
      targets.push({ type: 'USER', value: assignee.assignee_value });
    } else {
      const [members] = await executor.execute(
        `SELECT member.user_id
         FROM workflow_group_members member
         INNER JOIN workflow_groups workflow_group
           ON workflow_group.id = member.group_id
         INNER JOIN user_profiles user ON user.id = member.user_id
         WHERE member.group_id = ?
           AND workflow_group.is_active = 1
           AND user.is_active = 1`,
        [assignee.assignee_value]
      );
      targets.push(...members.map((member) => ({ type: 'USER', value: member.user_id })));
    }
  }
  return targets;
};

const notifyStage = async (executor, { stage, application, requestId }) => {
  const targets = await getNotificationTargets(executor, stage.id);
  if (targets.length === 0) return;
  await createSystemNotification(executor, {
    templateCode: 'VISITOR_WORKFLOW_STAGE_ASSIGNED',
    values: {
      reference: application.application_number,
      stage: stage.name
    },
    requestId,
    resourceType: 'visitor_application',
    resourceId: application.id,
    targets,
    channels: ['IN_APP', 'EMAIL'],
    metadata: {
      application_number: application.application_number,
      workflow_stage: stage.code
    }
  });
};

const startVisitorWorkflow = async (executor, application, requestId) => {
  const [existing] = await executor.execute(
    'SELECT id FROM application_workflow_instances WHERE application_id = ?',
    [application.id]
  );
  if (existing[0]) return existing[0].id;

  const [versions] = await executor.execute(
    `SELECT version.id
     FROM application_workflows workflow
     INNER JOIN application_workflow_versions version
       ON version.id = workflow.active_version_id
     WHERE workflow.application_type = 'VISITOR'
       AND workflow.is_active = 1
       AND version.status = 'ACTIVE'
     ORDER BY workflow.created_at
     LIMIT 1`
  );
  const version = versions[0];
  if (!version) {
    throw workflowError(
      503,
      'VISITOR_WORKFLOW_UNAVAILABLE',
      'No active visitor application workflow is configured.'
    );
  }

  const [stages] = await executor.execute(
    `SELECT id, code, name, sequence_number
     FROM application_workflow_stages
     WHERE version_id = ?
     ORDER BY sequence_number`,
    [version.id]
  );
  if (stages.length === 0) {
    throw workflowError(
      503,
      'VISITOR_WORKFLOW_EMPTY',
      'The active visitor application workflow has no stages.'
    );
  }

  const instanceId = uuidv4();
  await executor.execute(
    `INSERT INTO application_workflow_instances
     (id, application_id, version_id, current_stage_id)
     VALUES (?, ?, ?, ?)`,
    [instanceId, application.id, version.id, stages[0].id]
  );
  for (const [index, stage] of stages.entries()) {
    await executor.execute(
      `INSERT INTO application_stage_instances
       (id, workflow_instance_id, stage_id, status, activated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        instanceId,
        stage.id,
        index === 0 ? 'ACTIVE' : 'PENDING',
        index === 0 ? new Date() : null
      ]
    );
  }
  await notifyStage(executor, {
    stage: stages[0],
    application,
    requestId
  });
  return instanceId;
};

const isEligibleForStage = async (executor, stageId, user) => {
  const [rows] = await executor.execute(
    `SELECT assignee.id
     FROM workflow_stage_assignees assignee
     LEFT JOIN workflow_group_members member
       ON assignee.assignee_type = 'GROUP'
      AND member.group_id = assignee.assignee_value
      AND member.user_id = ?
     LEFT JOIN workflow_groups workflow_group
       ON workflow_group.id = member.group_id
     WHERE assignee.stage_id = ?
       AND (
         (assignee.assignee_type = 'ROLE' AND assignee.assignee_value = ?)
         OR (assignee.assignee_type = 'USER' AND assignee.assignee_value = ?)
         OR (assignee.assignee_type = 'GROUP' AND member.user_id IS NOT NULL
             AND workflow_group.is_active = 1)
       )
     LIMIT 1`,
    [user.id, stageId, user.role, user.id]
  );
  return Boolean(rows[0]);
};

const executeVisitorWorkflowAction = async (
  executor,
  {
    application,
    user,
    action,
    notes,
    approvedAreas,
    approvedVisitStarts,
    approvedVisitEnds,
    documentReviews,
    requestId
  }
) => {
  let [instances] = await executor.execute(
    `SELECT instance.id, instance.status, instance.current_stage_id,
            stage_instance.id AS stage_instance_id,
            stage.sequence_number, stage.code, stage.name,
            stage.allow_submitter_action, stage.require_different_actor,
            stage.captures_access_approval
     FROM application_workflow_instances instance
     INNER JOIN application_stage_instances stage_instance
       ON stage_instance.workflow_instance_id = instance.id
      AND stage_instance.stage_id = instance.current_stage_id
     INNER JOIN application_workflow_stages stage
       ON stage.id = stage_instance.stage_id
     WHERE instance.application_id = ?
     FOR UPDATE`,
    [application.id]
  );
  if (!instances[0] && application.status === 'SUBMITTED') {
    await startVisitorWorkflow(executor, application, requestId);
    [instances] = await executor.execute(
      `SELECT instance.id, instance.status, instance.current_stage_id,
              stage_instance.id AS stage_instance_id,
              stage.sequence_number, stage.code, stage.name,
              stage.allow_submitter_action, stage.require_different_actor,
              stage.captures_access_approval
       FROM application_workflow_instances instance
       INNER JOIN application_stage_instances stage_instance
         ON stage_instance.workflow_instance_id = instance.id
        AND stage_instance.stage_id = instance.current_stage_id
       INNER JOIN application_workflow_stages stage
         ON stage.id = stage_instance.stage_id
       WHERE instance.application_id = ?
       FOR UPDATE`,
      [application.id]
    );
  }
  const current = instances[0];
  if (!current || current.status !== 'ACTIVE') {
    throw workflowError(
      409,
      'WORKFLOW_NOT_ACTIVE',
      'This application does not have an active review stage.'
    );
  }
  if (!(await isEligibleForStage(executor, current.current_stage_id, user))) {
    throw workflowError(
      403,
      'WORKFLOW_STAGE_NOT_ASSIGNED',
      'This review stage is not assigned to you.'
    );
  }
  if (!current.allow_submitter_action && application.submitted_by === user.id) {
    throw workflowError(
      403,
      'WORKFLOW_SELF_APPROVAL_FORBIDDEN',
      'You cannot review an application that you submitted.'
    );
  }
  if (current.require_different_actor) {
    const [previousActions] = await executor.execute(
      `SELECT id FROM application_workflow_actions
       WHERE workflow_instance_id = ? AND actor_id = ? AND action = 'APPROVE'
       LIMIT 1`,
      [current.id, user.id]
    );
    if (previousActions[0]) {
      throw workflowError(
        403,
        'WORKFLOW_SEPARATION_OF_DUTIES',
        'A different officer must complete this stage.'
      );
    }
  }

  const hasAccessGrantFields = approvedAreas !== undefined
    || approvedVisitStarts !== undefined
    || approvedVisitEnds !== undefined
    || documentReviews !== undefined;
  if (hasAccessGrantFields && !current.captures_access_approval) {
    throw workflowError(
      422,
      'ACCESS_GRANT_FIELDS_NOT_ALLOWED',
      'Access grant fields may only be supplied at the designated supervisor stage.'
    );
  }

  if (current.captures_access_approval) {
    if (user.role !== 'supervisor') {
      throw workflowError(
        403,
        'ACCESS_AREA_APPROVAL_ROLE_REQUIRED',
        'Only a PSO or SSO with the supervisor role may complete the access grant review.'
      );
    }
    if (!documentReviews) {
      throw workflowError(
        422,
        'DOCUMENT_REVIEWS_REQUIRED',
        'Every submitted document must be reviewed at this workflow stage.'
      );
    }
    const reviewedDocuments = validateDocumentReviews(
      application.supporting_documents,
      documentReviews
    );
    await executor.execute(
      'DELETE FROM application_document_reviews WHERE application_id = ?',
      [application.id]
    );
    for (const review of reviewedDocuments) {
      await executor.execute(
        `INSERT INTO application_document_reviews
         (application_id, document_key, document_url, verdict, notes, reviewed_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          application.id,
          review.document_key,
          review.document_url,
          review.verdict,
          review.notes || null,
          user.id
        ]
      );
    }
  }

  if (action === 'APPROVE' && current.captures_access_approval) {
    if (!approvedAreas?.length) {
      throw workflowError(
        422,
        'APPROVED_ACCESS_AREAS_REQUIRED',
        'Approved access areas are required at this workflow stage.'
      );
    }
    if (!approvedVisitStarts || !approvedVisitEnds) {
      throw workflowError(
        422,
        'APPROVED_VISIT_DATES_REQUIRED',
        'Approved visit start and end dates are required at this workflow stage.'
      );
    }
    const requestedStart = toDateOnly(application.visit_starts);
    const requestedEnd = toDateOnly(application.visit_ends);
    if (approvedVisitStarts < requestedStart || approvedVisitEnds > requestedEnd) {
      throw workflowError(
        422,
        'APPROVED_VISIT_DATES_OUTSIDE_REQUEST',
        'Approved visit dates must remain within the applicant requested period.'
      );
    }
    if (
      application.identity_expiry_date
      && approvedVisitEnds > toDateOnly(application.identity_expiry_date)
    ) {
      throw workflowError(
        422,
        'APPROVED_VISIT_AFTER_IDENTITY_EXPIRY',
        'Approved access cannot extend beyond the identity document expiry date.'
      );
    }
    if (documentReviews.some((review) => review.verdict === 'INVALID')) {
      throw workflowError(
        422,
        'INVALID_DOCUMENTS_CANNOT_BE_APPROVED',
        'An application with an invalid supporting document cannot be approved.'
      );
    }
    const placeholders = approvedAreas.map(() => '?').join(', ');
    const [areas] = await executor.query(
      `SELECT code FROM access_areas
       WHERE code IN (${placeholders}) AND is_active = 1`,
      approvedAreas
    );
    if (areas.length !== approvedAreas.length) {
      throw workflowError(
        422,
        'APPROVED_ACCESS_AREA_INVALID',
        'One or more approved access areas are invalid or inactive.'
      );
    }
    await executor.execute(
      'DELETE FROM application_approved_access_areas WHERE application_id = ?',
      [application.id]
    );
    for (const areaCode of approvedAreas) {
      await executor.execute(
        `INSERT INTO application_approved_access_areas
         (application_id, area_code, approved_by)
         VALUES (?, ?, ?)`,
        [application.id, areaCode, user.id]
      );
    }
    await executor.execute(
      `UPDATE visitor_applications
       SET approved_visit_starts = ?, approved_visit_ends = ?
       WHERE id = ?`,
      [approvedVisitStarts, approvedVisitEnds, application.id]
    );
  }

  if (action === 'REJECT' && current.captures_access_approval) {
    if (approvedAreas !== undefined || approvedVisitStarts || approvedVisitEnds) {
      throw workflowError(
        422,
        'APPROVED_ACCESS_GRANT_NOT_ALLOWED_ON_REJECTION',
        'Approved dates and areas must be omitted when rejecting an application.'
      );
    }
    await executor.execute(
      `UPDATE visitor_applications
       SET approved_visit_starts = NULL, approved_visit_ends = NULL
       WHERE id = ?`,
      [application.id]
    );
    await executor.execute(
      'DELETE FROM application_approved_access_areas WHERE application_id = ?',
      [application.id]
    );
  }

  await executor.execute(
    `INSERT INTO application_workflow_actions
     (id, workflow_instance_id, stage_instance_id, action, actor_id, notes, request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), current.id, current.stage_instance_id, action, user.id, notes || null, requestId]
  );

  if (action === 'REJECT') {
    await executor.execute(
      `UPDATE application_stage_instances
       SET status = 'REJECTED', completed_at = NOW(3), completed_by = ?, notes = ?
       WHERE id = ?`,
      [user.id, notes, current.stage_instance_id]
    );
    await executor.execute(
      `UPDATE application_workflow_instances
       SET status = 'REJECTED', current_stage_id = NULL, completed_at = NOW(3)
       WHERE id = ?`,
      [current.id]
    );
    await executor.execute(
      `UPDATE visitor_applications
       SET status = 'REJECTED', reviewed_by = ?, reviewed_at = NOW(),
           review_notes = ?
       WHERE id = ?`,
      [user.id, notes, application.id]
    );
    return {
      status: 'REJECTED',
      completed: true,
      stage: current,
      actedStage: current
    };
  }

  await executor.execute(
    `UPDATE application_stage_instances
     SET status = 'APPROVED', completed_at = NOW(3), completed_by = ?, notes = ?
     WHERE id = ?`,
    [user.id, notes || null, current.stage_instance_id]
  );
  const [nextRows] = await executor.execute(
    `SELECT stage_instance.id AS stage_instance_id, stage.id, stage.code, stage.name
     FROM application_stage_instances stage_instance
     INNER JOIN application_workflow_stages stage ON stage.id = stage_instance.stage_id
     WHERE stage_instance.workflow_instance_id = ?
       AND stage.sequence_number > ?
     ORDER BY stage.sequence_number
     LIMIT 1`,
    [current.id, current.sequence_number]
  );
  const nextStage = nextRows[0];
  if (nextStage) {
    await executor.execute(
      `UPDATE application_stage_instances
       SET status = 'ACTIVE', activated_at = NOW(3)
       WHERE id = ?`,
      [nextStage.stage_instance_id]
    );
    await executor.execute(
      `UPDATE application_workflow_instances
       SET current_stage_id = ? WHERE id = ?`,
      [nextStage.id, current.id]
    );
    await executor.execute(
      `UPDATE visitor_applications SET status = 'UNDER_REVIEW' WHERE id = ?`,
      [application.id]
    );
    await notifyStage(executor, {
      stage: nextStage,
      application,
      requestId
    });
    return {
      status: 'UNDER_REVIEW',
      completed: false,
      stage: nextStage,
      actedStage: current
    };
  }

  await executor.execute(
    `UPDATE application_workflow_instances
     SET status = 'APPROVED', current_stage_id = NULL, completed_at = NOW(3)
     WHERE id = ?`,
    [current.id]
  );
  await executor.execute(
    `UPDATE visitor_applications
     SET status = 'APPROVED', reviewed_by = ?, reviewed_at = NOW(),
         review_notes = ?
     WHERE id = ?`,
    [user.id, notes || null, application.id]
  );
  await promoteApprovedVisitor(executor, application.id, user.id);
  return {
    status: 'APPROVED',
    completed: true,
    stage: current,
    actedStage: current
  };
};

module.exports = {
  executeVisitorWorkflowAction,
  getNotificationTargets,
  startVisitorWorkflow,
  workflowError
};
