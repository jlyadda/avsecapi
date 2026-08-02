const test = require('node:test');
const assert = require('node:assert/strict');
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
  return {
    jti,
    token: jwt.sign({ id: userId }, config.JWT_SECRET, {
      algorithm: 'HS256',
      audience: 'avsec-clients',
      issuer: 'avsecapi',
      jwtid: jti,
      expiresIn: 300
    })
  };
};

test('super admin creates and activates an immutable visitor workflow version', async () => {
  const server = await listen();
  const superAdminId = uuidv4();
  const adminId = uuidv4();
  let groupId;
  let workflowId;
  let versionId;
  let originalWorkflowId;
  let originalVersionId;

  try {
    const [[originalWorkflow]] = await db.query(
      `SELECT workflow.id AS workflow_id, workflow.active_version_id
       FROM application_workflows workflow
       INNER JOIN application_workflow_versions version
         ON version.id = workflow.active_version_id
       WHERE workflow.application_type = 'VISITOR'
         AND workflow.is_active = 1
         AND version.status = 'ACTIVE'
       LIMIT 1`
    );
    originalWorkflowId = originalWorkflow.workflow_id;
    originalVersionId = originalWorkflow.active_version_id;
    await db.execute(
      `INSERT INTO user_profiles
       (id, user_name, email, password_hash, full_name, department, user_role, is_active)
       VALUES (?, ?, ?, 'unused', ?, 'Aviation Security', 'super_admin', 1)`,
      [
        superAdminId,
        `workflow.super.${superAdminId.slice(0, 8)}`,
        `${superAdminId}@example.test`,
        'Workflow Super Admin'
      ]
    );
    await db.execute(
      `INSERT INTO user_profiles
       (id, user_name, email, password_hash, full_name, department, user_role, is_active)
       VALUES (?, ?, ?, 'unused', ?, 'Aviation Security', 'admin', 1)`,
      [
        adminId,
        `workflow.admin.${adminId.slice(0, 8)}`,
        `${adminId}@example.test`,
        'Workflow Manager'
      ]
    );
    const superSession = await createSessionToken(superAdminId);
    const adminSession = await createSessionToken(adminId);
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}/api`;
    const headers = {
      authorization: `Bearer ${superSession.token}`,
      'content-type': 'application/json'
    };

    const denied = await fetch(`${baseUrl}/application-workflows`, {
      headers: { authorization: `Bearer ${adminSession.token}` }
    });
    assert.equal(denied.status, 403);

    const groupResponse = await fetch(`${baseUrl}/workflow-groups`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code: `TEST_MANAGERS_${Date.now()}`,
        name: `Test Managers ${Date.now()}`,
        description: 'Temporary workflow test group',
        user_ids: [adminId]
      })
    });
    assert.equal(groupResponse.status, 201);
    groupId = (await groupResponse.json()).group.id;

    const workflowResponse = await fetch(`${baseUrl}/application-workflows`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code: `TEST_VISITOR_${Date.now()}`,
        name: `Test Visitor Workflow ${Date.now()}`,
        description: 'Temporary configurable workflow'
      })
    });
    assert.equal(workflowResponse.status, 201);
    workflowId = (await workflowResponse.json()).workflow.id;

    const versionResponse = await fetch(
      `${baseUrl}/application-workflows/${workflowId}/versions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          stages: [
            {
              code: 'CUSTOM_MANAGER_REVIEW',
              name: 'Custom Manager Review',
              sla_hours: 12,
              assignees: [{ type: 'GROUP', value: groupId }]
            },
            {
              code: 'CUSTOM_FACILITATION',
              name: 'Custom Facilitation',
              require_different_actor: true,
              assignees: [{ type: 'ROLE', value: 'security_assistant' }]
            }
          ]
        })
      }
    );
    assert.equal(versionResponse.status, 201);
    const version = (await versionResponse.json()).version;
    versionId = version.id;
    assert.equal(version.status, 'DRAFT');
    assert.equal(version.stages.length, 2);

    const activation = await fetch(
      `${baseUrl}/application-workflows/${workflowId}/versions/${versionId}/activate`,
      { method: 'POST', headers, body: '{}' }
    );
    assert.equal(activation.status, 200);

    const listed = await fetch(`${baseUrl}/application-workflows`, { headers });
    assert.equal(listed.status, 200);
    const workflows = (await listed.json()).workflows;
    const activated = workflows.find((workflow) => workflow.id === workflowId);
    assert.equal(activated.active_version_id, versionId);

    const secondActivation = await fetch(
      `${baseUrl}/application-workflows/${workflowId}/versions/${versionId}/activate`,
      { method: 'POST', headers, body: '{}' }
    );
    assert.equal(secondActivation.status, 409);
  } finally {
    if (originalWorkflowId && originalVersionId) {
      await db.execute(
        `UPDATE application_workflow_versions version
         INNER JOIN application_workflows workflow ON workflow.id = version.workflow_id
         SET version.status = 'RETIRED'
         WHERE workflow.application_type = 'VISITOR' AND version.status = 'ACTIVE'`
      );
      await db.execute(
        `UPDATE application_workflows
         SET active_version_id = NULL
         WHERE application_type = 'VISITOR'`
      );
      await db.execute(
        `UPDATE application_workflow_versions
         SET status = 'ACTIVE' WHERE id = ?`,
        [originalVersionId]
      );
      await db.execute(
        `UPDATE application_workflows
         SET active_version_id = ?, is_active = 1 WHERE id = ?`,
        [originalVersionId, originalWorkflowId]
      );
    }
    if (workflowId) {
      await db.execute(
        'DELETE FROM audit_events WHERE resource_id = ?',
        [workflowId]
      );
      await db.execute('DELETE FROM application_workflows WHERE id = ?', [workflowId]);
    }
    if (groupId) {
      await db.execute('DELETE FROM audit_events WHERE resource_id = ?', [groupId]);
      await db.execute('DELETE FROM workflow_groups WHERE id = ?', [groupId]);
    }
    await db.execute(
      'DELETE FROM audit_events WHERE actor_id IN (?, ?)',
      [superAdminId, adminId]
    );
    await db.execute(
      'DELETE FROM auth_tokens WHERE user_id IN (?, ?)',
      [superAdminId, adminId]
    );
    await db.execute(
      'DELETE FROM user_profiles WHERE id IN (?, ?)',
      [superAdminId, adminId]
    );
    await close(server);
  }
});
