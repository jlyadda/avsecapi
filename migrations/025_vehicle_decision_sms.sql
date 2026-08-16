INSERT INTO notification_templates
  (id, code, name, title_template, body_template, default_priority,
   category_code, is_system)
VALUES
  (UUID(), 'VEHICLE_APPLICATION_DECIDED', 'Vehicle application decision',
   'Vehicle access application {{decision}}',
   'Your vehicle access application {{reference}} was {{decision}}.',
   'NORMAL', 'VEHICLE_APPLICATIONS', 1);
