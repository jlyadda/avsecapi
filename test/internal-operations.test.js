const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const app = require('../app');
const config = require('../config');
const db = require('../db');

test.after(() => db.end());

const listen = async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
};

const close = (server) => new Promise((resolve) => server.close(resolve));

const createSessionToken = async (userId) => {
  const jti = uuidv4();
  await db.execute(
    'INSERT INTO auth_tokens (jti, user_id, expires_at) VALUES (?, ?, ?)',
    [jti, userId, new Date(Date.now() + 300000)]
  );
  const token = jwt.sign({ id: userId }, config.JWT_SECRET, {
    algorithm: 'HS256',
    audience: 'avsec-clients',
    issuer: 'avsecapi',
    jwtid: jti,
    expiresIn: 300
  });
  return { jti, token };
};

test('internal application, card, account, user list and refresh workflows', async () => {
  const server = await listen();
  const adminId = uuidv4();
  const managerId = uuidv4();
  const supervisorId = uuidv4();
  const assistantId = uuidv4();
  let cardId;
  let incompatibleCardId;
  let incompatibleCategoryCardId;
  let incompatibleCategoryId;
  const identityNumber = `OPS${Date.now()}`;
  const password = 'InitialPassword12!';
  let applicationId;
  let managerStageAssigneeId;
  let supervisorStageAssigneeId;
  let facilitationStageAssigneeId;

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    await db.execute(
      `INSERT INTO user_profiles
       (id, user_name, email, password_hash, full_name, department, user_role, is_active)
       VALUES (?, ?, ?, ?, ?, 'Aviation Security', 'admin', 1)`,
      [
        adminId,
        `ops.admin.${adminId.slice(0, 8)}`,
        `${adminId}@example.test`,
        passwordHash,
        'Operations Admin'
      ]
    );
    await db.execute(
      `INSERT INTO user_profiles
       (id, user_name, email, password_hash, full_name, department, user_role, is_active)
       VALUES (?, ?, ?, ?, ?, 'Aviation Security', 'admin', 1)`,
      [
        managerId,
        `ops.manager.${managerId.slice(0, 8)}`,
        `${managerId}@example.test`,
        passwordHash,
        'Operations Manager'
      ]
    );
    await db.execute(
      `INSERT INTO user_profiles
       (id, user_name, email, password_hash, full_name, department, user_role, is_active)
       VALUES (?, ?, ?, ?, ?, 'Aviation Security', 'supervisor', 1)`,
      [
        supervisorId,
        `ops.supervisor.${supervisorId.slice(0, 8)}`,
        `${supervisorId}@example.test`,
        passwordHash,
        'Operations Supervisor'
      ]
    );
    await db.execute(
      `INSERT INTO user_profiles
       (id, user_name, email, password_hash, full_name, department, user_role, is_active)
       VALUES (?, ?, ?, ?, ?, 'Aviation Security', 'security_assistant', 1)`,
      [
        assistantId,
        `ops.assistant.${assistantId.slice(0, 8)}`,
        `${assistantId}@example.test`,
        passwordHash,
        'Operations Assistant'
      ]
    );
    const adminSession = await createSessionToken(adminId);
    const managerSession = await createSessionToken(managerId);
    const supervisorSession = await createSessionToken(supervisorId);
    const assistantSession = await createSessionToken(assistantId);
    const [[managerStage]] = await db.query(
      `SELECT stage.id
       FROM application_workflows workflow
       INNER JOIN application_workflow_versions version
         ON version.id = workflow.active_version_id
       INNER JOIN application_workflow_stages stage
         ON stage.version_id = version.id
       WHERE workflow.application_type = 'VISITOR' AND workflow.is_active = 1
       ORDER BY stage.sequence_number
       LIMIT 1`
    );
    managerStageAssigneeId = uuidv4();
    await db.execute(
      `INSERT INTO workflow_stage_assignees
       (id, stage_id, assignee_type, assignee_value)
       VALUES (?, ?, 'USER', ?)`,
      [managerStageAssigneeId, managerStage.id, managerId]
    );
    const [[supervisorStage]] = await db.query(
      `SELECT stage.id
       FROM application_workflows workflow
       INNER JOIN application_workflow_versions version
         ON version.id = workflow.active_version_id
       INNER JOIN application_workflow_stages stage ON stage.version_id = version.id
       WHERE workflow.application_type = 'VISITOR'
         AND workflow.is_active = 1
         AND stage.code = 'SENIOR_SECURITY_REVIEW'
       LIMIT 1`
    );
    supervisorStageAssigneeId = uuidv4();
    await db.execute(
      `INSERT INTO workflow_stage_assignees
       (id, stage_id, assignee_type, assignee_value)
       VALUES (?, ?, 'USER', ?)`,
      [supervisorStageAssigneeId, supervisorStage.id, supervisorId]
    );
    const [[facilitationStage]] = await db.query(
      `SELECT stage.id
       FROM application_workflows workflow
       INNER JOIN application_workflow_versions version
         ON version.id = workflow.active_version_id
       INNER JOIN application_workflow_stages stage
         ON stage.version_id = version.id
       WHERE workflow.application_type = 'VISITOR'
         AND workflow.is_active = 1
         AND stage.code = 'FACILITATION_DESK'
       LIMIT 1`
    );
    facilitationStageAssigneeId = uuidv4();
    await db.execute(
      `INSERT INTO workflow_stage_assignees
       (id, stage_id, assignee_type, assignee_value)
       VALUES (?, ?, 'USER', ?)`,
      [facilitationStageAssigneeId, facilitationStage.id, assistantId]
    );
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}/api`;
    const headers = {
      authorization: `Bearer ${adminSession.token}`,
      'content-type': 'application/json'
    };
    const [[databaseClock]] = await db.query(
      "SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today"
    );
    const today = databaseClock.today;

    const created = await fetch(`${baseUrl}/visitor-applications`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        first_name: 'Internal',
        last_name: 'Visitor',
        date_of_birth: '1990-01-01',
        gender: 1,
        identity_type: 'NATIONAL_ID',
        identity_number: identityNumber,
        personal_phone: '+256700000010',
        personal_email: 'internal.visitor@example.test',
        company_name: 'Internal Operations Limited',
        company_position: 'Technician',
        visit_reasons: ['Internal route verification'],
        areas_of_access: ['Terminal'],
        visit_starts: today,
        visit_ends: today
      })
    });
    assert.equal(created.status, 201);
    const createdApplication = (await created.json()).application;
    applicationId = createdApplication.id;
    assert.equal(createdApplication.status, 'SUBMITTED');
    assert.equal(createdApplication.current_workflow_stage_code, 'MANAGER_REVIEW');

    const submitterTasks = await fetch(
      `${baseUrl}/workflow-tasks/mine?search=${identityNumber}`,
      { headers }
    );
    assert.equal(submitterTasks.status, 200);
    assert.equal((await submitterTasks.json()).pagination.total, 0);

    const managerTasks = await fetch(
      `${baseUrl}/workflow-tasks/mine?search=${identityNumber}`,
      { headers: { authorization: `Bearer ${managerSession.token}` } }
    );
    assert.equal(managerTasks.status, 200);
    assert.equal((await managerTasks.json()).pagination.total, 1);

    const listed = await fetch(
      `${baseUrl}/visitor-applications?search=${identityNumber}&status=SUBMITTED&page=1&page_size=10`,
      { headers }
    );
    assert.equal(listed.status, 200);
    const applicationList = await listed.json();
    assert.equal(applicationList.applications.length, 1);
    assert.equal(applicationList.pagination.total, 1);

    const users = await fetch(
      `${baseUrl}/users?role=security_assistant&is_active=true&search=Operations%20Assistant`,
      { headers }
    );
    assert.equal(users.status, 200);
    assert.equal((await users.json()).users.some((user) => user.id === assistantId), true);

    const createdCard = await fetch(`${baseUrl}/access-cards`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        number: `OPS${uuidv4().slice(0, 8)}`,
        access_level: 'LEVEL_1',
        category: 'VISITOR'
      })
    });
    assert.equal(createdCard.status, 201);
    const card = (await createdCard.json()).card;
    cardId = card.id;

    const accessAreasResponse = await fetch(`${baseUrl}/access-areas`, { headers });
    assert.equal(accessAreasResponse.status, 200);
    const accessAreas = (await accessAreasResponse.json()).access_areas;
    assert.equal(accessAreas.some((area) => area.code === 'PUBLIC_AREAS'), true);

    const levelAreasResponse = await fetch(
      `${baseUrl}/card-access-levels/LEVEL_1/areas`,
      { headers }
    );
    assert.equal(levelAreasResponse.status, 200);
    assert.deepEqual(
      (await levelAreasResponse.json()).access_areas.map((area) => area.code),
      ['PUBLIC_AREAS']
    );

    const incompatibleCardResponse = await fetch(`${baseUrl}/access-cards`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        number: `BAD${uuidv4().slice(0, 8)}`,
        access_level: 'LEVEL_3',
        category: 'VISITOR'
      })
    });
    assert.equal(incompatibleCardResponse.status, 201);
    const incompatibleCard = (await incompatibleCardResponse.json()).card;
    incompatibleCardId = incompatibleCard.id;

    const categoryCode = `NON_VISITOR_${uuidv4().slice(0, 8).toUpperCase()}`;
    const incompatibleCategoryDefinition = await fetch(`${baseUrl}/card-categories`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code: categoryCode,
        name: 'Non-visitor test category',
        can_assign_to_visitors: false
      })
    });
    assert.equal(incompatibleCategoryDefinition.status, 201);
    incompatibleCategoryId = (await incompatibleCategoryDefinition.json()).item.id;

    const incompatibleCategoryResponse = await fetch(`${baseUrl}/access-cards`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        number: `STAFF${uuidv4().slice(0, 8)}`,
        access_level: 'LEVEL_1',
        category: categoryCode
      })
    });
    assert.equal(incompatibleCategoryResponse.status, 201);
    const incompatibleCategoryCard = (await incompatibleCategoryResponse.json()).card;
    incompatibleCategoryCardId = incompatibleCategoryCard.id;

    const managerApproved = await fetch(
      `${baseUrl}/visitor-applications/${applicationId}/decision`,
      {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${managerSession.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ decision: 'APPROVED', notes: 'Verified for card test.' })
      }
    );
    assert.equal(managerApproved.status, 200);
    assert.equal((await managerApproved.json()).status, 'UNDER_REVIEW');

    const supervisorApproved = await fetch(
      `${baseUrl}/visitor-applications/${applicationId}/workflow/actions`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${supervisorSession.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          action: 'APPROVE',
          notes: 'Senior security approved public-area access.',
          approved_visit_starts: today,
          approved_visit_ends: today,
          approved_areas_of_access: ['PUBLIC_AREAS'],
          document_reviews: []
        })
      }
    );
    assert.equal(supervisorApproved.status, 200);
    assert.equal((await supervisorApproved.json()).workflow.status, 'UNDER_REVIEW');

    const facilitationApproved = await fetch(
      `${baseUrl}/visitor-applications/${applicationId}/workflow/actions`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${assistantSession.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ action: 'APPROVE', notes: 'Facilitation completed.' })
      }
    );
    assert.equal(facilitationApproved.status, 200);
    assert.equal((await facilitationApproved.json()).workflow.status, 'APPROVED');

    const approvedVisitorsResponse = await fetch(
      `${baseUrl}/visitors?search=${identityNumber}&status=APPROVED`,
      {
        headers: { authorization: `Bearer ${assistantSession.token}` }
      }
    );
    assert.equal(approvedVisitorsResponse.status, 200);
    const approvedVisitors = await approvedVisitorsResponse.json();
    assert.equal(approvedVisitors.pagination.total, 1);
    const approvedVisitor = approvedVisitors.visitors[0];
    assert.equal(approvedVisitor.application_id, applicationId);
    assert.deepEqual(approvedVisitor.approved_areas_of_access, ['PUBLIC_AREAS']);
    assert.equal(Boolean(approvedVisitor.pass_assignment_eligible), true);

    const eligibleVisitorsResponse = await fetch(
      `${baseUrl}/visitors?search=${identityNumber}&eligible_for_card_assignment=true`,
      { headers: { authorization: `Bearer ${assistantSession.token}` } }
    );
    assert.equal(eligibleVisitorsResponse.status, 200);
    assert.equal((await eligibleVisitorsResponse.json()).pagination.total, 1);

    const workflowHistory = await fetch(
      `${baseUrl}/visitor-applications/${applicationId}/workflow`,
      { headers }
    );
    assert.equal(workflowHistory.status, 200);
    const workflow = (await workflowHistory.json()).workflow;
    assert.equal(workflow.status, 'APPROVED');
    assert.equal(workflow.stages.length, 3);
    assert.equal(workflow.actions.length, 3);
    assert.equal(workflow.approved_visit_starts, today);
    assert.equal(workflow.approved_visit_ends, today);
    assert.deepEqual(workflow.document_reviews, []);

    const incompatibleAssignment = await fetch(
      `${baseUrl}/visitors/${approvedVisitor.id}/card-assignment`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${assistantSession.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          card_number: incompatibleCard.number,
          identity_document_retained: true
        })
      }
    );
    assert.equal(incompatibleAssignment.status, 409);
    const incompatibleAssignmentBody = await incompatibleAssignment.json();
    assert.equal(incompatibleAssignmentBody.code, 'CARD_ACCESS_LEVEL_MISMATCH');
    assert.deepEqual(incompatibleAssignmentBody.missing_areas, ['PUBLIC_AREAS']);

    const incompatibleCategoryAssignment = await fetch(
      `${baseUrl}/visitors/${approvedVisitor.id}/card-assignment`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${assistantSession.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          card_number: incompatibleCategoryCard.number.toLowerCase(),
          identity_document_retained: true
        })
      }
    );
    assert.equal(incompatibleCategoryAssignment.status, 409);
    assert.equal(
      (await incompatibleCategoryAssignment.json()).code,
      'CARD_CATEGORY_NOT_VISITOR_COMPATIBLE'
    );

    const assigned = await fetch(
      `${baseUrl}/visitors/${approvedVisitor.id}/card-assignment`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${assistantSession.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          card_number: card.number,
          identity_document_retained: true
        })
      }
    );
    assert.equal(assigned.status, 200);
    assert.equal((await assigned.json()).visitor.card_status, 'ASSIGNED');

    const activeAssignment = await fetch(
      `${baseUrl}/access-cards/active-assignment?card_number=${encodeURIComponent(card.number)}`,
      { headers: { authorization: `Bearer ${assistantSession.token}` } }
    );
    assert.equal(activeAssignment.status, 200);
    const activeAssignmentBody = (await activeAssignment.json()).assignment;
    assert.equal(activeAssignmentBody.card.number, card.number);
    assert.equal(activeAssignmentBody.visitor.application_id, applicationId);
    assert.match(activeAssignmentBody.visitor.retained_identity_document.masked_number,
      /^\*{4}.{4}$/);
    assert.equal(activeAssignmentBody.visitor.retained_identity_document.retained, true);
    assert.equal(activeAssignmentBody.allowed_duration_seconds, 12 * 60 * 60);
    assert.equal(activeAssignmentBody.held_duration_seconds >= 0, true);

    const checkedIn = await fetch(
      `${baseUrl}/visitor-applications/${applicationId}/check-in`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${assistantSession.token}`,
          'content-type': 'application/json'
        },
        body: '{}'
      }
    );
    assert.equal(checkedIn.status, 200);

    const blockedCheckout = await fetch(
      `${baseUrl}/visitor-applications/${applicationId}/check-out`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${assistantSession.token}`,
          'content-type': 'application/json'
        },
        body: '{}'
      }
    );
    assert.equal(blockedCheckout.status, 409);

    const returned = await fetch(
      `${baseUrl}/access-cards/active-assignment/return`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${assistantSession.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          card_number: card.number,
          identity_document_returned: true,
          return_condition: 'GOOD'
        })
      }
    );
    assert.equal(returned.status, 200);
    assert.equal((await returned.json()).return.identity_document_returned, true);

    const assignmentStatistics = await fetch(
      `${baseUrl}/statistics/pass-assignments?from=${today}&to=${today}&interval=day`,
      { headers }
    );
    assert.equal(assignmentStatistics.status, 200);
    const assignmentStatisticsBody = await assignmentStatistics.json();
    const todayPoint = assignmentStatisticsBody.points.find((point) => point.date === today);
    assert.ok(todayPoint);
    assert.equal(todayPoint.assigned >= 1, true);
    assert.equal(todayPoint.returned >= 1, true);

    const accountUpdate = await fetch(`${baseUrl}/account`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ full_name: 'Updated Operations Admin' })
    });
    assert.equal(accountUpdate.status, 200);
    assert.equal((await accountUpdate.json()).account.full_name, 'Updated Operations Admin');

    const passwordChange = await fetch(`${baseUrl}/account/password`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        current_password: password,
        new_password: 'ReplacementPassword12!'
      })
    });
    assert.equal(passwordChange.status, 200);

    const refreshed = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers
    });
    assert.equal(refreshed.status, 200);
    const refreshBody = await refreshed.json();
    assert.ok(refreshBody.token);

    const oldTokenRejected = await fetch(`${baseUrl}/account`, { headers });
    assert.equal(oldTokenRejected.status, 403);
    const newTokenAccepted = await fetch(`${baseUrl}/account`, {
      headers: { authorization: `Bearer ${refreshBody.token}` }
    });
    assert.equal(newTokenAccepted.status, 200);
  } finally {
    if (managerStageAssigneeId) {
      await db.execute(
        'DELETE FROM workflow_stage_assignees WHERE id = ?',
        [managerStageAssigneeId]
      );
    }
    if (supervisorStageAssigneeId) {
      await db.execute(
        'DELETE FROM workflow_stage_assignees WHERE id = ?',
        [supervisorStageAssigneeId]
      );
    }
    if (facilitationStageAssigneeId) {
      await db.execute(
        'DELETE FROM workflow_stage_assignees WHERE id = ?',
        [facilitationStageAssigneeId]
      );
    }
    if (applicationId) {
      await db.execute('DELETE FROM notifications WHERE resource_id = ?', [applicationId]);
    }
    await db.execute(
      `DELETE FROM audit_events
       WHERE actor_id IN (?, ?, ?, ?)
         OR resource_id IN (?, ?, ?, ?)`,
      [
        adminId,
        managerId,
        supervisorId,
        assistantId,
        applicationId || '',
        cardId || '',
        incompatibleCardId || '',
        incompatibleCategoryCardId || ''
      ]
    );
    if (applicationId) {
      await db.execute('DELETE FROM card_events WHERE application_id = ?', [applicationId]);
      await db.execute('DELETE FROM card_assignments WHERE application_id = ?', [applicationId]);
      await db.execute('DELETE FROM visit_sessions WHERE application_id = ?', [applicationId]);
      await db.execute('DELETE FROM visitor_applications WHERE id = ?', [applicationId]);
    }
    if (cardId) {
      await db.execute('DELETE FROM card_events WHERE card_id = ?', [cardId]);
      await db.execute('DELETE FROM access_cards WHERE id = ?', [cardId]);
    }
    if (incompatibleCardId) {
      await db.execute('DELETE FROM card_events WHERE card_id = ?', [incompatibleCardId]);
      await db.execute('DELETE FROM access_cards WHERE id = ?', [incompatibleCardId]);
    }
    if (incompatibleCategoryCardId) {
      await db.execute('DELETE FROM card_events WHERE card_id = ?', [incompatibleCategoryCardId]);
      await db.execute('DELETE FROM access_cards WHERE id = ?', [incompatibleCategoryCardId]);
    }
    if (incompatibleCategoryId) {
      await db.execute('DELETE FROM card_categories WHERE id = ?', [incompatibleCategoryId]);
    }
    await db.execute('DELETE FROM avsec_visitors WHERE identity_number = ?', [identityNumber]);
    await db.execute(
      'DELETE FROM auth_tokens WHERE user_id IN (?, ?, ?, ?)',
      [adminId, managerId, supervisorId, assistantId]
    );
    await db.execute(
      'DELETE FROM user_profiles WHERE id IN (?, ?, ?, ?)',
      [adminId, managerId, supervisorId, assistantId]
    );
    await close(server);
  }
});
