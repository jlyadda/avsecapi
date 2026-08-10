UPDATE application_workflow_stages stage
INNER JOIN application_workflow_versions version ON version.id = stage.version_id
INNER JOIN application_workflows workflow ON workflow.id = version.workflow_id
SET stage.captures_access_approval = CASE
  WHEN stage.code = 'SENIOR_SECURITY_REVIEW' THEN 1
  ELSE 0
END
WHERE workflow.application_type = 'VISITOR';
