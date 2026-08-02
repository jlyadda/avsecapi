const { v4: uuidv4 } = require('uuid');

const promoteApprovedVisitor = async (executor, applicationId, approvedBy) => {
  await executor.execute(
    `INSERT INTO visitors
     (id, application_id, visitor_profile_id, application_number, full_name,
      company, email, phone, visit_reasons, areas_of_access, valid_from,
      valid_until, status, approved_by, approved_at)
     SELECT ?, application.id, profile.id, application.application_number,
            CONCAT_WS(' ', profile.first_name, profile.other_names, profile.last_name),
            application.company_name, application.personal_email,
            application.personal_phone, application.visit_reasons,
            COALESCE(application.areas_of_access, JSON_ARRAY()),
            application.visit_starts, application.visit_ends,
            'APPROVED', ?, NOW()
     FROM visitor_applications application
     INNER JOIN avsec_visitors profile ON profile.id = application.visitor_id
     WHERE application.id = ? AND application.status = 'APPROVED'
     ON DUPLICATE KEY UPDATE
       full_name = VALUES(full_name), company = VALUES(company),
       email = VALUES(email), phone = VALUES(phone),
       visit_reasons = VALUES(visit_reasons),
       areas_of_access = VALUES(areas_of_access),
       valid_from = VALUES(valid_from), valid_until = VALUES(valid_until),
       status = 'APPROVED', approved_by = VALUES(approved_by),
       approved_at = VALUES(approved_at)`,
    [uuidv4(), approvedBy, applicationId]
  );
};

module.exports = { promoteApprovedVisitor };
