ALTER TABLE card_categories
  ADD COLUMN IF NOT EXISTS can_assign_to_visitors TINYINT(1) NOT NULL DEFAULT 0 AFTER is_active;

UPDATE card_categories
SET can_assign_to_visitors = 1
WHERE code = 'VISITOR';
