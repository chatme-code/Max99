-- Migration: reputation_score_to_level
-- Mirrors Java's ReputationScoreToLevel DB table (ReputationLevelData.java)
-- SELECT score, level FROM ReputationScoreToLevel ORDER BY score DESC

CREATE TABLE IF NOT EXISTS reputation_score_to_level (
  level                    INTEGER PRIMARY KEY,
  score                    INTEGER NOT NULL DEFAULT 0,
  name                     TEXT,
  image                    TEXT,
  chat_room_size           INTEGER,
  group_size               INTEGER,
  num_group_chat_rooms     INTEGER,
  create_chat_room         BOOLEAN NOT NULL DEFAULT false,
  create_group             BOOLEAN NOT NULL DEFAULT false,
  publish_photo            BOOLEAN NOT NULL DEFAULT false,
  post_comment_like_user_wall BOOLEAN NOT NULL DEFAULT false,
  add_to_photo_wall        BOOLEAN NOT NULL DEFAULT false,
  enter_pot                BOOLEAN NOT NULL DEFAULT false,
  num_group_moderators     INTEGER NOT NULL DEFAULT 0
);

-- Seed initial level data
-- Mirrors migme production ReputationScoreToLevel thresholds
INSERT INTO reputation_score_to_level
  (level, score, name, chat_room_size, group_size, num_group_chat_rooms,
   create_chat_room, create_group, publish_photo, post_comment_like_user_wall,
   add_to_photo_wall, enter_pot, num_group_moderators)
VALUES
  (1,     0,      'Newbie',    NULL,  NULL,  NULL, false, false, false, false, false, false, 0),
  (2,     100,    'Beginner',  10,    NULL,  NULL, true,  false, true,  true,  false, false, 0),
  (3,     300,    'Learner',   20,    NULL,  NULL, true,  false, true,  true,  false, false, 0),
  (4,     700,    'Member',    20,    20,    1,    true,  true,  true,  true,  true,  false, 1),
  (5,     1500,   'Active',    30,    30,    2,    true,  true,  true,  true,  true,  false, 2),
  (6,     3000,   'Regular',   30,    50,    3,    true,  true,  true,  true,  true,  true,  2),
  (7,     6000,   'Senior',    50,    50,    5,    true,  true,  true,  true,  true,  true,  3),
  (8,     12000,  'Expert',    50,    100,   5,    true,  true,  true,  true,  true,  true,  5),
  (9,     25000,  'Master',    100,   100,   10,   true,  true,  true,  true,  true,  true,  5),
  (10,    50000,  'Legend',    100,   200,   10,   true,  true,  true,  true,  true,  true,  10)
ON CONFLICT (level) DO NOTHING;
