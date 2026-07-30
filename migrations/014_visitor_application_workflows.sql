ALTER TABLE visitor_applications
  MODIFY status ENUM(
    'SUBMITTED','UNDER_REVIEW','NEEDS_CORRECTION','APPROVED','REJECTED',
    'CHECKED_IN','CHECKED_OUT','CANCELLED'
  ) NOT NULL DEFAULT 'SUBMITTED',
  ADD COLUMN submitted_by CHAR(36) DEFAULT NULL AFTER source_key_hash,
  ADD KEY visitor_applications_submitted_by_idx (submitted_by),
  ADD CONSTRAINT visitor_applications_submitted_by_fkey
    FOREIGN KEY (submitted_by) REFERENCES user_profiles (id) ON DELETE SET NULL;

CREATE TABLE workflow_groups (
  id CHAR(36) NOT NULL,
  code VARCHAR(80) NOT NULL,
  name VARCHAR(150) NOT NULL,
  description VARCHAR(500) DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by CHAR(36) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY workflow_groups_code_key (code),
  UNIQUE KEY workflow_groups_name_key (name),
  CONSTRAINT workflow_groups_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES user_profiles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE workflow_group_members (
  group_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  added_by CHAR(36) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (group_id, user_id),
  KEY workflow_group_members_user_idx (user_id),
  CONSTRAINT workflow_group_members_group_fkey
    FOREIGN KEY (group_id) REFERENCES workflow_groups (id) ON DELETE CASCADE,
  CONSTRAINT workflow_group_members_user_fkey
    FOREIGN KEY (user_id) REFERENCES user_profiles (id) ON DELETE CASCADE,
  CONSTRAINT workflow_group_members_added_by_fkey
    FOREIGN KEY (added_by) REFERENCES user_profiles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE application_workflows (
  id CHAR(36) NOT NULL,
  code VARCHAR(80) NOT NULL,
  name VARCHAR(150) NOT NULL,
  description VARCHAR(500) DEFAULT NULL,
  application_type ENUM('VISITOR') NOT NULL DEFAULT 'VISITOR',
  active_version_id CHAR(36) DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by CHAR(36) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY application_workflows_code_key (code),
  KEY application_workflows_active_version_idx (active_version_id),
  CONSTRAINT application_workflows_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES user_profiles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE application_workflow_versions (
  id CHAR(36) NOT NULL,
  workflow_id CHAR(36) NOT NULL,
  version_number INT UNSIGNED NOT NULL,
  status ENUM('DRAFT','ACTIVE','RETIRED') NOT NULL DEFAULT 'DRAFT',
  created_by CHAR(36) DEFAULT NULL,
  activated_by CHAR(36) DEFAULT NULL,
  activated_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY workflow_versions_number_key (workflow_id, version_number),
  KEY workflow_versions_status_idx (workflow_id, status),
  CONSTRAINT workflow_versions_workflow_fkey
    FOREIGN KEY (workflow_id) REFERENCES application_workflows (id) ON DELETE CASCADE,
  CONSTRAINT workflow_versions_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES user_profiles (id) ON DELETE SET NULL,
  CONSTRAINT workflow_versions_activated_by_fkey
    FOREIGN KEY (activated_by) REFERENCES user_profiles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE application_workflow_stages (
  id CHAR(36) NOT NULL,
  version_id CHAR(36) NOT NULL,
  sequence_number SMALLINT UNSIGNED NOT NULL,
  code VARCHAR(80) NOT NULL,
  name VARCHAR(150) NOT NULL,
  description VARCHAR(500) DEFAULT NULL,
  approval_policy ENUM('ANY_ONE') NOT NULL DEFAULT 'ANY_ONE',
  allow_submitter_action TINYINT(1) NOT NULL DEFAULT 0,
  require_different_actor TINYINT(1) NOT NULL DEFAULT 1,
  sla_hours SMALLINT UNSIGNED DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY workflow_stages_sequence_key (version_id, sequence_number),
  UNIQUE KEY workflow_stages_code_key (version_id, code),
  CONSTRAINT workflow_stages_version_fkey
    FOREIGN KEY (version_id) REFERENCES application_workflow_versions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE workflow_stage_assignees (
  id CHAR(36) NOT NULL,
  stage_id CHAR(36) NOT NULL,
  assignee_type ENUM('ROLE','GROUP','USER') NOT NULL,
  assignee_value VARCHAR(100) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY workflow_stage_assignees_unique_key
    (stage_id, assignee_type, assignee_value),
  KEY workflow_stage_assignees_lookup_idx (assignee_type, assignee_value),
  CONSTRAINT workflow_stage_assignees_stage_fkey
    FOREIGN KEY (stage_id) REFERENCES application_workflow_stages (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE application_workflow_instances (
  id CHAR(36) NOT NULL,
  application_id CHAR(36) NOT NULL,
  version_id CHAR(36) NOT NULL,
  current_stage_id CHAR(36) DEFAULT NULL,
  status ENUM('ACTIVE','APPROVED','REJECTED','NEEDS_CORRECTION','CANCELLED')
    NOT NULL DEFAULT 'ACTIVE',
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY workflow_instances_application_key (application_id),
  KEY workflow_instances_current_stage_idx (current_stage_id, status),
  CONSTRAINT workflow_instances_application_fkey
    FOREIGN KEY (application_id) REFERENCES visitor_applications (id) ON DELETE CASCADE,
  CONSTRAINT workflow_instances_version_fkey
    FOREIGN KEY (version_id) REFERENCES application_workflow_versions (id),
  CONSTRAINT workflow_instances_current_stage_fkey
    FOREIGN KEY (current_stage_id) REFERENCES application_workflow_stages (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE application_stage_instances (
  id CHAR(36) NOT NULL,
  workflow_instance_id CHAR(36) NOT NULL,
  stage_id CHAR(36) NOT NULL,
  status ENUM('PENDING','ACTIVE','APPROVED','REJECTED','SKIPPED')
    NOT NULL DEFAULT 'PENDING',
  activated_at DATETIME(3) DEFAULT NULL,
  completed_at DATETIME(3) DEFAULT NULL,
  completed_by CHAR(36) DEFAULT NULL,
  notes TEXT DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY stage_instances_workflow_stage_key (workflow_instance_id, stage_id),
  KEY stage_instances_status_idx (status, activated_at),
  CONSTRAINT stage_instances_workflow_fkey
    FOREIGN KEY (workflow_instance_id) REFERENCES application_workflow_instances (id)
      ON DELETE CASCADE,
  CONSTRAINT stage_instances_stage_fkey
    FOREIGN KEY (stage_id) REFERENCES application_workflow_stages (id),
  CONSTRAINT stage_instances_completed_by_fkey
    FOREIGN KEY (completed_by) REFERENCES user_profiles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE application_workflow_actions (
  id CHAR(36) NOT NULL,
  workflow_instance_id CHAR(36) NOT NULL,
  stage_instance_id CHAR(36) NOT NULL,
  action ENUM('APPROVE','REJECT') NOT NULL,
  actor_id CHAR(36) NOT NULL,
  notes TEXT DEFAULT NULL,
  request_id CHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY workflow_actions_instance_idx (workflow_instance_id, created_at),
  KEY workflow_actions_actor_idx (actor_id, created_at),
  CONSTRAINT workflow_actions_workflow_fkey
    FOREIGN KEY (workflow_instance_id) REFERENCES application_workflow_instances (id),
  CONSTRAINT workflow_actions_stage_instance_fkey
    FOREIGN KEY (stage_instance_id) REFERENCES application_stage_instances (id),
  CONSTRAINT workflow_actions_actor_fkey
    FOREIGN KEY (actor_id) REFERENCES user_profiles (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO workflow_groups
  (id, code, name, description)
VALUES
  ('10000000-0000-4000-8000-000000000001', 'MANAGERS', 'Managers',
   'Managers responsible for first-line application review'),
  ('10000000-0000-4000-8000-000000000002', 'PSO', 'Principal Security Officers',
   'Principal Security Officers'),
  ('10000000-0000-4000-8000-000000000003', 'SSO', 'Senior Security Officers',
   'Senior Security Officers'),
  ('10000000-0000-4000-8000-000000000004', 'FACILITATION_DESK', 'Facilitation Desk',
   'Security assistants at the facilitation desk');

INSERT INTO application_workflows
  (id, code, name, description, active_version_id)
VALUES
  ('20000000-0000-4000-8000-000000000001', 'DEFAULT_VISITOR_ACCESS',
   'Default Visitor Access Approval',
   'Manager, senior security, and facilitation desk approval hierarchy',
   '30000000-0000-4000-8000-000000000001');

INSERT INTO application_workflow_versions
  (id, workflow_id, version_number, status, activated_at)
VALUES
  ('30000000-0000-4000-8000-000000000001',
   '20000000-0000-4000-8000-000000000001', 1, 'ACTIVE', NOW(3));

INSERT INTO application_workflow_stages
  (id, version_id, sequence_number, code, name, description,
   allow_submitter_action, require_different_actor, sla_hours)
VALUES
  ('40000000-0000-4000-8000-000000000001',
   '30000000-0000-4000-8000-000000000001', 1, 'MANAGER_REVIEW',
   'Manager Review', 'Initial management review', 0, 1, 24),
  ('40000000-0000-4000-8000-000000000002',
   '30000000-0000-4000-8000-000000000001', 2, 'SENIOR_SECURITY_REVIEW',
   'PSO or SSO Review', 'Senior aviation security review', 0, 1, 24),
  ('40000000-0000-4000-8000-000000000003',
   '30000000-0000-4000-8000-000000000001', 3, 'FACILITATION_DESK',
   'Facilitation Desk', 'Final processing by the facilitation desk', 0, 1, 24);

INSERT INTO workflow_stage_assignees
  (id, stage_id, assignee_type, assignee_value)
VALUES
  (UUID(), '40000000-0000-4000-8000-000000000001', 'GROUP',
   '10000000-0000-4000-8000-000000000001'),
  (UUID(), '40000000-0000-4000-8000-000000000001', 'ROLE', 'admin'),
  (UUID(), '40000000-0000-4000-8000-000000000002', 'GROUP',
   '10000000-0000-4000-8000-000000000002'),
  (UUID(), '40000000-0000-4000-8000-000000000002', 'GROUP',
   '10000000-0000-4000-8000-000000000003'),
  (UUID(), '40000000-0000-4000-8000-000000000002', 'ROLE', 'supervisor'),
  (UUID(), '40000000-0000-4000-8000-000000000003', 'GROUP',
   '10000000-0000-4000-8000-000000000004'),
  (UUID(), '40000000-0000-4000-8000-000000000003', 'ROLE', 'security_assistant');

INSERT INTO notification_templates
  (id, code, name, title_template, body_template, default_priority)
VALUES
  (UUID(), 'VISITOR_WORKFLOW_STAGE_ASSIGNED', 'Visitor workflow stage assigned',
   'Application awaiting {{stage}}',
   'Visitor application {{reference}} is awaiting {{stage}}.', 'HIGH'),
  (UUID(), 'VISITOR_WORKFLOW_COMPLETED', 'Visitor workflow completed',
   'Visitor application {{decision}}',
   'Visitor application {{reference}} was {{decision}}.', 'NORMAL');
