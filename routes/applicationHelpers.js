const applicationSelect = `
  SELECT a.*, v.first_name, v.last_name, v.other_names, v.identity_type, v.identity_number,
         v.issuing_country, v.date_of_birth, v.gender, v.image_url,
         CURDATE() BETWEEN a.visit_starts AND a.visit_ends AS within_visit_period,
         c.id AS card_id, c.number AS card_number, c.access_level AS card_access_level,
         card_level.name AS card_access_level_name,
         c.category AS card_category, card_category.name AS card_category_name,
         CASE
           WHEN c.is_active = 0 THEN 'UNAVAILABLE'
           WHEN c.is_lost = 1 THEN 'LOST'
           WHEN c.is_damaged = 1 THEN 'DAMAGED'
           WHEN c.is_assigned = 1 THEN 'ASSIGNED'
           WHEN c.is_available = 1 THEN 'AVAILABLE'
           ELSE 'UNAVAILABLE'
         END AS card_status,
         a.reviewed_by AS reviewed_by_id,
         COALESCE(reviewer.full_name, reviewer.user_name) AS reviewed_by
  FROM visitor_applications a
  INNER JOIN avsec_visitors v ON v.id = a.visitor_id
  LEFT JOIN user_profiles reviewer ON reviewer.id = a.reviewed_by
  LEFT JOIN access_cards c ON c.current_application_id = a.id
  LEFT JOIN card_access_levels card_level ON card_level.code = c.access_level
  LEFT JOIN card_categories card_category ON card_category.code = c.category`;

const findApplication = async (executor, reference, lock = false) => {
  const [rows] = await executor.execute(
    `${applicationSelect}
     WHERE a.id = ? OR a.application_number = ?
     LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [reference, reference]
  );
  return rows[0];
};

module.exports = { applicationSelect, findApplication };
