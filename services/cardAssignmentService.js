const { v4: uuidv4 } = require('uuid');
const { recordAudit } = require('../audit');

const cardError = (status, code, message) => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
};

const assignAccessCard = async (
  executor,
  { application, cardNumber, actorId, requestId }
) => {
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
            category.is_active AS category_is_active
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

  await executor.execute(
    `INSERT INTO card_assignments (id, card_id, application_id, assigned_by)
     VALUES (?, ?, ?, ?)`,
    [uuidv4(), card.id, application.id, actorId]
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
      application_number: application.application_number
    }
  });
  return card;
};

const returnAccessCard = async (executor, { application, actorId, requestId }) => {
  const [assignmentRows] = await executor.execute(
    `SELECT assignment.id, assignment.card_id
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
  await executor.execute(
    'SELECT id FROM access_cards WHERE id = ? FOR UPDATE',
    [assignment.card_id]
  );
  await executor.execute(
    `UPDATE card_assignments
     SET status = 'RETURNED', returned_by = ?, returned_at = NOW(),
         return_condition = 'GOOD'
     WHERE id = ?`,
    [actorId, assignment.id]
  );
  await executor.execute(
    `INSERT INTO card_events
     (id, card_id, application_id, event_type, performed_by)
     VALUES (?, ?, ?, 'RETURNED', ?)`,
    [uuidv4(), assignment.card_id, application.id, actorId]
  );
  await executor.execute(
    `UPDATE access_cards
     SET current_application_id = NULL, holder_name = NULL, holder_phone = NULL,
         is_assigned = 0, is_available = 1, is_returned = 1,
         last_return_date = NOW()
     WHERE id = ?`,
    [assignment.card_id]
  );
  await recordAudit(executor, {
    actorId,
    action: 'ACCESS_CARD_RETURNED',
    resourceType: 'access_card',
    resourceId: assignment.card_id,
    requestId,
    metadata: {
      application_id: application.id,
      application_number: application.application_number
    }
  });
  return assignment;
};

module.exports = { assignAccessCard, cardError, returnAccessCard };
