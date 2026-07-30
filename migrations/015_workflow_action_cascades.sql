ALTER TABLE application_workflow_actions
  DROP FOREIGN KEY workflow_actions_workflow_fkey,
  DROP FOREIGN KEY workflow_actions_stage_instance_fkey;

ALTER TABLE application_workflow_actions
  ADD CONSTRAINT workflow_actions_workflow_fkey
    FOREIGN KEY (workflow_instance_id) REFERENCES application_workflow_instances (id)
      ON DELETE CASCADE,
  ADD CONSTRAINT workflow_actions_stage_instance_fkey
    FOREIGN KEY (stage_instance_id) REFERENCES application_stage_instances (id)
      ON DELETE CASCADE;
