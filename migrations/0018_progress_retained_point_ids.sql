PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN progress_retained_point_ids TEXT NOT NULL DEFAULT '[]';
