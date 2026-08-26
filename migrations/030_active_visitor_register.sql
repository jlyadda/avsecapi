RENAME TABLE avsec_visitors TO all_visitors;

ALTER TABLE visitors
  MODIFY COLUMN status ENUM(
    'APPROVED','PENDING_VALIDITY','ELIGIBLE','CHECKED_IN','CHECKED_OUT','CANCELLED','REVOKED'
  ) NOT NULL DEFAULT 'ELIGIBLE';

ALTER TABLE visitors
  CHANGE COLUMN visitor_profile_id all_visitor_id BIGINT(20) NOT NULL,
  ALGORITHM=INPLACE;

INSERT INTO audit_events
  (id, actor_id, action, resource_type, resource_id, request_id, metadata)
SELECT UUID(), NULL, 'ACTIVE_VISITOR_REMOVED', 'visitor', visitor.id, UUID(),
       JSON_OBJECT(
         'application_id', visitor.application_id,
         'reason', CASE
           WHEN visitor.valid_until < CURDATE() THEN 'VISIT_PERIOD_EXPIRED'
           ELSE CONCAT('STATUS_', visitor.status)
         END,
         'valid_until', visitor.valid_until
       )
FROM visitors visitor
WHERE visitor.status IN ('CANCELLED', 'REVOKED') OR visitor.valid_until < CURDATE();

DELETE FROM visitors
WHERE status IN ('CANCELLED', 'REVOKED') OR valid_until < CURDATE();

UPDATE visitors visitor
LEFT JOIN card_assignments assignment
  ON assignment.application_id = visitor.application_id
 AND assignment.status = 'ACTIVE'
SET visitor.status = CASE
  WHEN assignment.id IS NOT NULL THEN 'CHECKED_IN'
  WHEN visitor.status = 'CHECKED_OUT' THEN 'CHECKED_OUT'
  WHEN visitor.valid_from > CURDATE() THEN 'PENDING_VALIDITY'
  ELSE 'ELIGIBLE'
END;

ALTER TABLE visitors
  MODIFY COLUMN status ENUM('PENDING_VALIDITY','ELIGIBLE','CHECKED_IN','CHECKED_OUT')
    NOT NULL DEFAULT 'ELIGIBLE';

ALTER TABLE visit_sessions
  DROP INDEX visit_sessions_application_key,
  ADD KEY visit_sessions_application_status_idx (application_id, status, checked_in_at);
