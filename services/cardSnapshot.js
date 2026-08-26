const snapshotSelect = `
  SELECT c.id, c.number, c.access_level, level.name AS access_level_name,
         c.category, category.name AS category_name, c.created_at,
         CASE latest.event_type
           WHEN 'ASSIGNED' THEN 'ASSIGNED'
           WHEN 'MARKED_UNAVAILABLE' THEN 'UNAVAILABLE'
           WHEN 'MARKED_DAMAGED' THEN 'DAMAGED'
           WHEN 'MARKED_LOST' THEN 'LOST'
           ELSE 'AVAILABLE'
         END AS status,
         assignment.id AS assignment_id,
         assignment.application_id,
         application.application_number,
         CASE
           WHEN latest.event_type = 'ASSIGNED'
           THEN CONCAT_WS(' ', visitor.first_name, visitor.other_names, visitor.last_name)
           ELSE NULL
         END AS holder_name,
         CASE
           WHEN latest.event_type = 'ASSIGNED' THEN application.personal_phone
           ELSE NULL
         END AS holder_phone,
         CASE
           WHEN latest.event_type = 'ASSIGNED' THEN assignment.assigned_at
           ELSE NULL
         END AS assigned_at,
         latest.created_at AS last_event_at
  FROM access_cards c
  INNER JOIN card_access_levels level ON level.code = c.access_level
  INNER JOIN card_categories category ON category.code = c.category
  LEFT JOIN card_events latest ON latest.id = (
    SELECT event.id
    FROM card_events event
    WHERE event.card_id = c.id
      AND event.created_at < DATE_ADD(?, INTERVAL 1 DAY)
    ORDER BY event.created_at DESC, event.event_order DESC
    LIMIT 1
  )
  LEFT JOIN card_assignments assignment
    ON assignment.card_id = c.id
   AND assignment.assigned_at < DATE_ADD(?, INTERVAL 1 DAY)
   AND (
     assignment.returned_at IS NULL
     OR assignment.returned_at >= DATE_ADD(?, INTERVAL 1 DAY)
   )
  LEFT JOIN visitor_applications application
    ON application.id = assignment.application_id
  LEFT JOIN all_visitors visitor
    ON visitor.id = application.visitor_id
  WHERE c.created_at < DATE_ADD(?, INTERVAL 1 DAY)`;

const snapshotParameters = (date) => [date, date, date, date];

module.exports = { snapshotSelect, snapshotParameters };
