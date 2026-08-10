ALTER TABLE visitor_applications
  ADD COLUMN IF NOT EXISTS approved_visit_starts DATE DEFAULT NULL AFTER visit_ends,
  ADD COLUMN IF NOT EXISTS approved_visit_ends DATE DEFAULT NULL AFTER approved_visit_starts;

CREATE TABLE IF NOT EXISTS application_document_reviews (
  application_id CHAR(36) NOT NULL,
  document_key VARCHAR(80) NOT NULL,
  document_url TEXT NOT NULL,
  verdict ENUM('VALID','INVALID') NOT NULL,
  notes VARCHAR(1000) DEFAULT NULL,
  reviewed_by CHAR(36) DEFAULT NULL,
  reviewed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (application_id, document_key),
  KEY application_document_reviews_reviewer_idx (reviewed_by),
  CONSTRAINT application_document_reviews_application_fkey
    FOREIGN KEY (application_id) REFERENCES visitor_applications (id) ON DELETE CASCADE,
  CONSTRAINT application_document_reviews_reviewer_fkey
    FOREIGN KEY (reviewed_by) REFERENCES user_profiles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

UPDATE visitor_applications
SET approved_visit_starts = visit_starts,
    approved_visit_ends = visit_ends
WHERE status IN ('APPROVED','CHECKED_IN','CHECKED_OUT','CANCELLED')
  AND approved_visit_starts IS NULL
  AND approved_visit_ends IS NULL;

INSERT IGNORE INTO application_document_reviews
  (application_id, document_key, document_url, verdict, notes, reviewed_by, reviewed_at)
SELECT id, 'IDENTITY_DOCUMENT',
       JSON_UNQUOTE(JSON_EXTRACT(supporting_documents, '$.identity_document_url')),
       'VALID', 'Legacy approval backfill.', reviewed_by,
       COALESCE(reviewed_at, updated_at)
FROM visitor_applications
WHERE status IN ('APPROVED','CHECKED_IN','CHECKED_OUT','CANCELLED')
  AND JSON_UNQUOTE(JSON_EXTRACT(supporting_documents, '$.identity_document_url')) IS NOT NULL;

INSERT IGNORE INTO application_document_reviews
  (application_id, document_key, document_url, verdict, notes, reviewed_by, reviewed_at)
SELECT id, 'AVSEC_ENDORSED_LETTER',
       JSON_UNQUOTE(JSON_EXTRACT(supporting_documents, '$.avsec_endorsed_letter_url')),
       'VALID', 'Legacy approval backfill.', reviewed_by,
       COALESCE(reviewed_at, updated_at)
FROM visitor_applications
WHERE status IN ('APPROVED','CHECKED_IN','CHECKED_OUT','CANCELLED')
  AND JSON_UNQUOTE(JSON_EXTRACT(supporting_documents, '$.avsec_endorsed_letter_url')) IS NOT NULL;

INSERT IGNORE INTO application_document_reviews
  (application_id, document_key, document_url, verdict, notes, reviewed_by, reviewed_at)
SELECT id, 'PASSPORT_PHOTOGRAPH',
       JSON_UNQUOTE(JSON_EXTRACT(supporting_documents, '$.passport_photograph_url')),
       'VALID', 'Legacy approval backfill.', reviewed_by,
       COALESCE(reviewed_at, updated_at)
FROM visitor_applications
WHERE status IN ('APPROVED','CHECKED_IN','CHECKED_OUT','CANCELLED')
  AND JSON_UNQUOTE(JSON_EXTRACT(supporting_documents, '$.passport_photograph_url')) IS NOT NULL;

INSERT IGNORE INTO application_document_reviews
  (application_id, document_key, document_url, verdict, notes, reviewed_by, reviewed_at)
SELECT application.id, CONCAT('OTHER_DOCUMENT_', positions.position + 1),
       JSON_UNQUOTE(JSON_EXTRACT(
         application.supporting_documents,
         CONCAT('$.other_document_urls[', positions.position, ']')
       )),
       'VALID', 'Legacy approval backfill.', application.reviewed_by,
       COALESCE(application.reviewed_at, application.updated_at)
FROM visitor_applications application
INNER JOIN (
  SELECT 0 AS position UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3
  UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7
  UNION ALL SELECT 8 UNION ALL SELECT 9
) positions
WHERE application.status IN ('APPROVED','CHECKED_IN','CHECKED_OUT','CANCELLED')
  AND JSON_UNQUOTE(JSON_EXTRACT(
    application.supporting_documents,
    CONCAT('$.other_document_urls[', positions.position, ']')
  )) IS NOT NULL;

UPDATE visitors visitor
INNER JOIN visitor_applications application ON application.id = visitor.application_id
SET visitor.valid_from = COALESCE(application.approved_visit_starts, application.visit_starts),
    visitor.valid_until = COALESCE(application.approved_visit_ends, application.visit_ends);
