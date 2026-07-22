ALTER TABLE avsec_visitors
  ADD COLUMN gender_boolean TINYINT(1) DEFAULT NULL AFTER gender;

UPDATE avsec_visitors
SET gender_boolean = CASE
  WHEN gender = 'MALE' THEN 1
  WHEN gender = 'FEMALE' THEN 0
  ELSE NULL
END;

ALTER TABLE avsec_visitors
  DROP COLUMN gender,
  CHANGE gender_boolean gender TINYINT(1) DEFAULT NULL;
