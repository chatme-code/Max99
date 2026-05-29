-- Migration: expand reputation levels from 10 to 50
-- Replaces old 10-level data with a 50-level progression that is easier to climb.
-- XP formula: score(n) ≈ 20 * (n-1)^1.5  (Level 50 ≈ 6860 XP vs old Level 10 = 50000 XP)

-- Remove old levels so we can reinsert all 50
DELETE FROM reputation_score_to_level;

INSERT INTO reputation_score_to_level
  (level, score, name, chat_room_size, group_size, num_group_chat_rooms,
   create_chat_room, create_group, publish_photo, post_comment_like_user_wall,
   add_to_photo_wall, enter_pot, num_group_moderators)
VALUES
  -- Tier 1: Newbie (1-5)
  (1,   0,    'Newbie',      NULL, NULL, NULL, false, false, false, false, false, false, 0),
  (2,   20,   'Newcomer',    5,    NULL, NULL, false, false, true,  false, false, false, 0),
  (3,   55,   'Rookie',      7,    NULL, NULL, true,  false, true,  true,  false, false, 0),
  (4,   105,  'Beginner',    9,    NULL, NULL, true,  false, true,  true,  true,  false, 0),
  (5,   160,  'Apprentice',  11,   5,    1,    true,  true,  true,  true,  true,  false, 1),
  -- Tier 2: Learner (6-10)
  (6,   225,  'Learner',     13,   8,    1,    true,  true,  true,  true,  true,  false, 1),
  (7,   295,  'Student',     15,   10,   1,    true,  true,  true,  true,  true,  false, 1),
  (8,   370,  'Scholar',     17,   12,   2,    true,  true,  true,  true,  true,  false, 1),
  (9,   455,  'Trainee',     19,   14,   2,    true,  true,  true,  true,  true,  false, 2),
  (10,  540,  'Explorer',    21,   16,   2,    true,  true,  true,  true,  true,  true,  2),
  -- Tier 3: Adventurer (11-15)
  (11,  635,  'Adventurer',  23,   18,   2,    true,  true,  true,  true,  true,  true,  2),
  (12,  730,  'Wanderer',    25,   20,   3,    true,  true,  true,  true,  true,  true,  2),
  (13,  830,  'Voyager',     27,   22,   3,    true,  true,  true,  true,  true,  true,  2),
  (14,  935,  'Seeker',      29,   24,   3,    true,  true,  true,  true,  true,  true,  3),
  (15,  1050, 'Discoverer',  31,   26,   3,    true,  true,  true,  true,  true,  true,  3),
  -- Tier 4: Member (16-20)
  (16,  1160, 'Initiate',    33,   28,   4,    true,  true,  true,  true,  true,  true,  3),
  (17,  1280, 'Participant', 35,   30,   4,    true,  true,  true,  true,  true,  true,  3),
  (18,  1400, 'Contributor', 37,   33,   4,    true,  true,  true,  true,  true,  true,  3),
  (19,  1525, 'Member',      39,   36,   5,    true,  true,  true,  true,  true,  true,  4),
  (20,  1655, 'Regular',     41,   40,   5,    true,  true,  true,  true,  true,  true,  4),
  -- Tier 5: Active (21-25)
  (21,  1790, 'Active',      43,   44,   5,    true,  true,  true,  true,  true,  true,  4),
  (22,  1925, 'Enthusiast',  45,   48,   5,    true,  true,  true,  true,  true,  true,  4),
  (23,  2065, 'Veteran',     47,   52,   6,    true,  true,  true,  true,  true,  true,  4),
  (24,  2205, 'Devoted',     49,   56,   6,    true,  true,  true,  true,  true,  true,  5),
  (25,  2350, 'Dedicated',   51,   60,   6,    true,  true,  true,  true,  true,  true,  5),
  -- Tier 6: Senior (26-30)
  (26,  2500, 'Senior',      54,   65,   7,    true,  true,  true,  true,  true,  true,  5),
  (27,  2650, 'Experienced', 57,   70,   7,    true,  true,  true,  true,  true,  true,  5),
  (28,  2805, 'Skilled',     60,   75,   7,    true,  true,  true,  true,  true,  true,  5),
  (29,  2965, 'Proficient',  63,   80,   8,    true,  true,  true,  true,  true,  true,  6),
  (30,  3125, 'Advanced',    66,   85,   8,    true,  true,  true,  true,  true,  true,  6),
  -- Tier 7: Expert (31-35)
  (31,  3285, 'Expert',      69,   90,   8,    true,  true,  true,  true,  true,  true,  6),
  (32,  3455, 'Specialist',  72,   95,   8,    true,  true,  true,  true,  true,  true,  6),
  (33,  3620, 'Professional',75,   100,  9,    true,  true,  true,  true,  true,  true,  6),
  (34,  3790, 'Authority',   78,   105,  9,    true,  true,  true,  true,  true,  true,  7),
  (35,  3965, 'Champion',    81,   110,  9,    true,  true,  true,  true,  true,  true,  7),
  -- Tier 8: Master (36-40)
  (36,  4145, 'Master',      84,   115,  9,    true,  true,  true,  true,  true,  true,  7),
  (37,  4320, 'Virtuoso',    87,   120,  10,   true,  true,  true,  true,  true,  true,  7),
  (38,  4505, 'Elite',       90,   130,  10,   true,  true,  true,  true,  true,  true,  7),
  (39,  4685, 'Ace',         93,   140,  10,   true,  true,  true,  true,  true,  true,  8),
  (40,  4870, 'Prodigy',     95,   150,  10,   true,  true,  true,  true,  true,  true,  8),
  -- Tier 9: Legend (41-45)
  (41,  5060, 'Grandmaster', 96,   155,  10,   true,  true,  true,  true,  true,  true,  8),
  (42,  5255, 'Legend',      97,   160,  10,   true,  true,  true,  true,  true,  true,  8),
  (43,  5440, 'Icon',        97,   165,  10,   true,  true,  true,  true,  true,  true,  9),
  (44,  5640, 'Mythic',      98,   170,  10,   true,  true,  true,  true,  true,  true,  9),
  (45,  5835, 'Epic',        98,   175,  10,   true,  true,  true,  true,  true,  true,  9),
  -- Tier 10: God (46-50)
  (46,  6035, 'Legendary',   99,   180,  10,   true,  true,  true,  true,  true,  true,  9),
  (47,  6240, 'Immortal',    99,   185,  10,   true,  true,  true,  true,  true,  true,  9),
  (48,  6450, 'Titan',       100,  190,  10,   true,  true,  true,  true,  true,  true,  10),
  (49,  6655, 'Demigod',     100,  195,  10,   true,  true,  true,  true,  true,  true,  10),
  (50,  6860, 'God',         100,  200,  10,   true,  true,  true,  true,  true,  true,  10)
ON CONFLICT (level) DO UPDATE SET
  score                    = EXCLUDED.score,
  name                     = EXCLUDED.name,
  chat_room_size           = EXCLUDED.chat_room_size,
  group_size               = EXCLUDED.group_size,
  num_group_chat_rooms     = EXCLUDED.num_group_chat_rooms,
  create_chat_room         = EXCLUDED.create_chat_room,
  create_group             = EXCLUDED.create_group,
  publish_photo            = EXCLUDED.publish_photo,
  post_comment_like_user_wall = EXCLUDED.post_comment_like_user_wall,
  add_to_photo_wall        = EXCLUDED.add_to_photo_wall,
  enter_pot                = EXCLUDED.enter_pot,
  num_group_moderators     = EXCLUDED.num_group_moderators;
