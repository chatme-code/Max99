-- Set Dice game minimum bet (amountJoinPot) to 500 IDR.
-- Maximum bet is uncapped on the application side; we keep maxAmountJoinPot
-- as a sentinel so the param() override remains effective.

UPDATE bot_configs
SET property_value = '500'
WHERE property_name = 'amountJoinPot'
  AND bot_id IN (SELECT id FROM bots WHERE LOWER(game) = 'dice');

INSERT INTO bot_configs (bot_id, property_name, property_value, description)
SELECT b.id, 'amountJoinPot', '500', 'Minimum bet (IDR) to join Dice game'
FROM bots b
WHERE LOWER(b.game) = 'dice'
  AND NOT EXISTS (
    SELECT 1 FROM bot_configs c
    WHERE c.bot_id = b.id AND c.property_name = 'amountJoinPot'
  );

UPDATE bot_configs
SET property_value = '9007199254740991'
WHERE property_name = 'maxAmountJoinPot'
  AND bot_id IN (SELECT id FROM bots WHERE LOWER(game) = 'dice');
