ALTER TABLE avsec_visitors
  ADD COLUMN identity_expiry_date DATE DEFAULT NULL AFTER date_of_birth;

ALTER TABLE visitor_applications
  ADD COLUMN identity_expiry_date DATE DEFAULT NULL AFTER phone,
  ADD COLUMN company_address VARCHAR(500) DEFAULT NULL AFTER company_position,
  ADD COLUMN company_phone VARCHAR(50) DEFAULT NULL AFTER company_address,
  ADD COLUMN company_email VARCHAR(255) DEFAULT NULL AFTER company_phone,
  ADD COLUMN company_registration_number VARCHAR(100) DEFAULT NULL AFTER company_email,
  ADD COLUMN areas_of_access JSON DEFAULT NULL AFTER company_registration_number,
  ADD COLUMN supporting_documents JSON DEFAULT NULL AFTER areas_of_access;
