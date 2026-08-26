const { getSubmittedDocuments, parseJsonObject } = require('../services/documentReviewService');

const applicationSelect = `
  SELECT a.*, v.first_name, v.last_name, v.other_names, v.identity_type, v.identity_number,
         v.issuing_country, v.date_of_birth, v.gender, v.image_url,
         CURDATE() BETWEEN COALESCE(a.approved_visit_starts, a.visit_starts)
           AND COALESCE(a.approved_visit_ends, a.visit_ends) AS within_visit_period,
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
         COALESCE(reviewer.full_name, reviewer.user_name) AS reviewed_by,
         workflow_instance.status AS workflow_status,
         workflow_stage.code AS current_workflow_stage_code,
         workflow_stage.name AS current_workflow_stage_name,
         (
           SELECT CONCAT(
             '[',
             GROUP_CONCAT(JSON_QUOTE(approved.area_code) ORDER BY approved.area_code SEPARATOR ','),
             ']'
           )
           FROM application_approved_access_areas approved
           WHERE approved.application_id = a.id
         ) AS approved_areas_of_access,
         (
           SELECT CONCAT(
             '[',
             GROUP_CONCAT(
               JSON_OBJECT(
                 'document_key', review.document_key,
                 'document_url', review.document_url,
                 'verdict', review.verdict,
                 'notes', review.notes,
                 'reviewed_by_id', review.reviewed_by,
                 'reviewed_by', COALESCE(document_reviewer.full_name, document_reviewer.user_name),
                 'reviewed_at', review.reviewed_at
               )
               ORDER BY review.document_key SEPARATOR ','
             ),
             ']'
           )
           FROM application_document_reviews review
           LEFT JOIN user_profiles document_reviewer ON document_reviewer.id = review.reviewed_by
           WHERE review.application_id = a.id
         ) AS document_reviews
  FROM visitor_applications a
  INNER JOIN all_visitors v ON v.id = a.visitor_id
  LEFT JOIN user_profiles reviewer ON reviewer.id = a.reviewed_by
  LEFT JOIN application_workflow_instances workflow_instance
    ON workflow_instance.application_id = a.id
  LEFT JOIN application_workflow_stages workflow_stage
    ON workflow_stage.id = workflow_instance.current_stage_id
  LEFT JOIN access_cards c ON c.current_application_id = a.id
  LEFT JOIN card_access_levels card_level ON card_level.code = c.access_level
  LEFT JOIN card_categories card_category ON card_category.code = c.category`;

const toDateOnly = (value) => {
  if (!value || typeof value === 'string') return value?.slice(0, 10) || null;
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const normalizeApplication = (application) => {
  if (!application) return application;
  let approvedAreas = application.approved_areas_of_access;
  if (typeof approvedAreas === 'string') {
    try {
      approvedAreas = JSON.parse(approvedAreas);
    } catch {
      approvedAreas = [];
    }
  }
  let documentReviews = application.document_reviews;
  if (typeof documentReviews === 'string') {
    try {
      documentReviews = JSON.parse(documentReviews);
    } catch {
      documentReviews = [];
    }
  }
  const supportingDocuments = parseJsonObject(application.supporting_documents);
  return {
    ...application,
    visit_starts: toDateOnly(application.visit_starts),
    visit_ends: toDateOnly(application.visit_ends),
    approved_visit_starts: toDateOnly(application.approved_visit_starts),
    approved_visit_ends: toDateOnly(application.approved_visit_ends),
    supporting_documents: supportingDocuments,
    submitted_documents: getSubmittedDocuments(supportingDocuments),
    approved_areas_of_access: Array.isArray(approvedAreas) ? approvedAreas : [],
    document_reviews: Array.isArray(documentReviews) ? documentReviews : []
  };
};

const findApplication = async (executor, reference, lock = false) => {
  const [rows] = await executor.execute(
    `${applicationSelect}
     WHERE a.id = ? OR a.application_number = ?
     LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [reference, reference]
  );
  return normalizeApplication(rows[0]);
};

module.exports = { applicationSelect, findApplication, normalizeApplication };
