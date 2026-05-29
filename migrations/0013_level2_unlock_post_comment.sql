-- Migration: enable post/comment/like on wall for Level 2 (Newcomer)
-- Level 2 users should be able to create posts, comment and like from level 2 onward.
UPDATE reputation_score_to_level
SET post_comment_like_user_wall = true
WHERE level = 2;
