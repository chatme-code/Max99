UPDATE reputation_score_to_level
SET score = CASE
  WHEN level <= 1 THEN 0
  WHEN level <= 30 THEN ROUND(7000 * POWER(((level - 1)::numeric / 29), 1.5))::integer
  WHEN level <= 50 THEN ROUND(7000 + 18000 * POWER(((level - 30)::numeric / 20), 1.25))::integer
  ELSE score
END
WHERE level BETWEEN 1 AND 50;