const { v4: uuidv4 } = require('uuid');

const recordAudit = async (
  executor,
  { actorId = null, action, resourceType, resourceId, requestId, metadata = {} }
) => {
  await executor.execute(
    `INSERT INTO audit_events
     (id, actor_id, action, resource_type, resource_id, request_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidv4(),
      actorId,
      action,
      resourceType,
      String(resourceId),
      requestId,
      JSON.stringify(metadata)
    ]
  );
};

const sendError = (res, status, code, message) => (
  res.status(status).json({ error: message, code })
);

module.exports = { recordAudit, sendError };
