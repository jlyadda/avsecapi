ALTER TABLE avsec_visitors
  ADD COLUMN other_names VARCHAR(255) DEFAULT NULL AFTER last_name,
  MODIFY identity_type ENUM('PASSPORT','NATIONAL_ID','DRIVERS_LICENSE') NOT NULL,
  MODIFY issuing_country VARCHAR(100) NOT NULL;

ALTER TABLE visitor_applications
  CHANGE email personal_email VARCHAR(255) NOT NULL,
  CHANGE phone personal_phone VARCHAR(50) NOT NULL,
  ADD COLUMN alternative_personal_phone VARCHAR(50) DEFAULT NULL AFTER personal_phone,
  CHANGE company company_name VARCHAR(255) NOT NULL,
  DROP COLUMN company_registration_number,
  CHANGE purpose visit_reasons JSON NOT NULL,
  DROP COLUMN host_name,
  DROP COLUMN host_email,
  CHANGE expected_arrival visit_starts DATE NOT NULL,
  CHANGE expected_departure visit_ends DATE NOT NULL;
