const { v4: uuidv4 } = require('uuid');
const { recordAudit } = require('../audit');

const cardError = (status, code, message, details = {}) => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  Object.assign(error, details);
  return error;
};

const assignAccessCard = async (
  executor,
  { application, cardNumber, identityDocumentRetained, actorId, requestId }
) => {
  if (identityDocumentRetained !== true) {
    throw cardError(400, 'IDENTITY_DOCUMENT_RETENTION_REQUIRED',
      'Confirm that the visitor identity document has been retained.');
  }
  if (!application.identity_type || !application.identity_number) {
    throw cardError(409, 'VISITOR_IDENTITY_DOCUMENT_UNAVAILABLE',
      'The visitor has no identity document available for custody recording.');
  }
  if (!['APPROVED', 'CHECKED_IN'].includes(application.status)) {
    throw cardError(
      409,
      'APPLICATION_NOT_PASS_ELIGIBLE',
      `A card cannot be assigned while the application is ${application.status}.`
    );
  }
  if (!application.within_visit_period) {
    throw cardError(
      409,
      'VISIT_OUTSIDE_APPROVED_PERIOD',
      'The visit is outside its approved date range.'
    );
  }
  if (application.card_id) {
    throw cardError(
      409,
      'APPLICATION_CARD_ALREADY_ASSIGNED',
      'This visitor already has an assigned card for the application.'
    );
  }

  const [cardRows] = await executor.execute(
    `SELECT card.*, level.is_active AS access_level_is_active,
            category.is_active AS category_is_active,
            category.can_assign_to_visitors
     FROM access_cards card
     INNER JOIN card_access_levels level ON level.code = card.access_level
     INNER JOIN card_categories category ON category.code = card.category
     WHERE card.number = ?
     LIMIT 1 FOR UPDATE`,
    [cardNumber]
  );
  const card = cardRows[0];
  if (!card) {
    throw cardError(404, 'ACCESS_CARD_NOT_FOUND', 'Access card not found.');
  }
  if (
    !card.is_active
    || !card.access_level_is_active
    || !card.category_is_active
    || card.is_lost
    || card.is_damaged
    || card.is_assigned
    || !card.is_available
  ) {
    throw cardError(
      409,
      'ACCESS_CARD_UNAVAILABLE',
      'Access card is not available for assignment.'
    );
  }
  if (!card.can_assign_to_visitors) {
    throw cardError(
      409,
      'CARD_CATEGORY_NOT_VISITOR_COMPATIBLE',
      'This card category cannot be assigned to visitors.'
    );
  }

  const [approvedAreas] = await executor.execute(
    `SELECT approved.area_code, area.name
     FROM application_approved_access_areas approved
     INNER JOIN access_areas area ON area.code = approved.area_code
     WHERE approved.application_id = ? AND area.is_active = 1
     ORDER BY area.sort_order, area.name`,
    [application.id]
  );
  if (approvedAreas.length === 0) {
    throw cardError(
      409,
      'VISITOR_HAS_NO_APPROVED_ACCESS_AREAS',
      'The visitor has no approved access areas and cannot be assigned a card.'
    );
  }
  const [missingAreas] = await executor.execute(
    `SELECT approved.area_code, area.name
     FROM application_approved_access_areas approved
     INNER JOIN access_areas area ON area.code = approved.area_code
     LEFT JOIN card_access_level_areas permitted
       ON permitted.area_code = approved.area_code
      AND permitted.access_level_code = ?
     WHERE approved.application_id = ?
       AND (area.is_active = 0 OR permitted.area_code IS NULL)
     ORDER BY area.sort_order, area.name`,
    [card.access_level, application.id]
  );
  if (missingAreas.length > 0) {
    throw cardError(
      409,
      'CARD_ACCESS_LEVEL_MISMATCH',
      'The selected card does not cover all approved access areas.',
      { missingAreas: missingAreas.map((area) => area.area_code) }
    );
  }

  const [[settings]] = await executor.execute(
    'SELECT max_hold_hours FROM pass_return_settings WHERE id = 1 FOR UPDATE'
  );
  if (!settings) {
    throw cardError(503, 'PASS_RETURN_SETTINGS_UNAVAILABLE',
      'Pass-return settings are unavailable.');
  }
  const assignmentId = uuidv4();
  await executor.execute(
    `INSERT INTO card_assignments
     (id, card_id, application_id, assigned_by, due_at,
      retained_identity_type, retained_identity_number_last4, identity_retained_at)
     VALUES (?, ?, ?, ?, DATE_ADD(NOW(3), INTERVAL ? HOUR), ?, ?, NOW(3))`,
    [assignmentId, card.id, application.id, actorId, settings.max_hold_hours,
      application.identity_type, String(application.identity_number).slice(-4)]
  );
  await executor.execute(
    `INSERT INTO card_events
     (id, card_id, application_id, event_type, performed_by)
     VALUES (?, ?, ?, 'ASSIGNED', ?)`,
    [uuidv4(), card.id, application.id, actorId]
  );
  await executor.execute(
    `UPDATE access_cards
     SET current_application_id = ?, holder_name = ?, holder_phone = ?,
         is_assigned = 1, is_available = 0, is_returned = 0
     WHERE id = ?`,
    [
      application.id,
      `${application.first_name} ${application.last_name}`,
      application.personal_phone,
      card.id
    ]
  );
  await recordAudit(executor, {
    actorId,
    action: 'ACCESS_CARD_ASSIGNED',
    resourceType: 'access_card',
    resourceId: card.id,
    requestId,
    metadata: {
      application_id: application.id,
      application_number: application.application_number,
      approved_areas: approvedAreas.map((area) => area.area_code),
      retained_identity_type: application.identity_type,
      max_hold_hours: Number(settings.max_hold_hours)
    }
  });
  return { ...card, assignmentId, maxHoldHours: Number(settings.max_hold_hours) };
};

const returnAccessCard = async (
  executor,
  { application, identityDocumentReturned, returnCondition = 'GOOD', actorId, requestId }
) => {
  if (identityDocumentReturned !== true) {
    throw cardError(400, 'IDENTITY_DOCUMENT_RETURN_CONFIRMATION_REQUIRED',
      'Confirm that the retained identity document was returned to the visitor.');
  }
  const [assignmentRows] = await executor.execute(
    `SELECT assignment.id, assignment.card_id, assignment.due_at,
            assignment.identity_retained_at, assignment.identity_released_at
     FROM card_assignments assignment
     WHERE assignment.application_id = ? AND assignment.status = 'ACTIVE'
     LIMIT 1 FOR UPDATE`,
    [application.id]
  );
  const assignment = assignmentRows[0];
  if (!assignment) {
    throw cardError(
      409,
      'APPLICATION_HAS_NO_ACTIVE_CARD',
      'This visitor has no active card assignment.'
    );
  }
  if (!assignment.identity_retained_at || assignment.identity_released_at) {
    throw cardError(409, 'IDENTITY_DOCUMENT_CUSTODY_INVALID',
      'The retained identity document custody record is invalid.');
  }
  await executor.execute(
    'SELECT id FROM access_cards WHERE id = ? FOR UPDATE',
    [assignment.card_id]
  );
  await executor.execute(
    `UPDATE card_assignments
     SET status = 'RETURNED', returned_by = ?, returned_at = NOW(),
         return_condition = ?, identity_released_at = NOW(3),
         identity_released_by = ?
     WHERE id = ?`,
    [actorId, returnCondition, actorId, assignment.id]
  );
  await executor.execute(
    `INSERT INTO card_events
     (id, card_id, application_id, event_type, performed_by)
     VALUES (?, ?, ?, 'RETURNED', ?)`,
    [uuidv4(), assignment.card_id, application.id, actorId]
  );
  if (returnCondition === 'DAMAGED') {
    await executor.execute(
      `INSERT INTO card_events
       (id, card_id, application_id, event_type, performed_by)
       VALUES (?, ?, ?, 'MARKED_DAMAGED', ?)`,
      [uuidv4(), assignment.card_id, application.id, actorId]
    );
  }
  await executor.execute(
    `UPDATE access_cards
     SET current_application_id = NULL, holder_name = NULL, holder_phone = NULL,
         is_assigned = 0, is_available = ?, is_returned = 1,
         is_damaged = CASE WHEN ? = 1 THEN 1 ELSE is_damaged END,
         last_return_date = NOW()
     WHERE id = ?`,
    [returnCondition === 'GOOD' ? 1 : 0, returnCondition === 'DAMAGED' ? 1 : 0,
      assignment.card_id]
  );
  await recordAudit(executor, {
    actorId,
    action: 'ACCESS_CARD_RETURNED',
    resourceType: 'access_card',
    resourceId: assignment.card_id,
    requestId,
    metadata: {
      application_id: application.id,
      application_number: application.application_number,
      return_condition: returnCondition,
      identity_document_returned: true,
      returned_overdue: new Date() > new Date(assignment.due_at)
    }
  });
  return assignment;
};

module.exports = { assignAccessCard, cardError, returnAccessCard };
