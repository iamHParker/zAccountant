-- Card numbers on an account (Homer, 2026-11-26): "we will need alias numbers. When a card is lost or stolen the digits
-- change but still the same account." A bank or card account keeps every last-four it has had (old and new card), so a
-- receipt printed "MASTERCARD 7413" finds its account even after the card was replaced. Only the last four digits,
-- never a whole card number. No two active accounts of one company share a number (checked in ledgerService).
ALTER TABLE accounts ADD COLUMN card_numbers text[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(card_numbers) <= 12 AND array_to_string(card_numbers, ',') ~ '^(\d{4}(,\d{4})*)?$');
