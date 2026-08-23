CREATE TRIGGER IF NOT EXISTS prevent_ugc_submissions_delete
BEFORE DELETE ON ugc_submissions
BEGIN
  SELECT RAISE(ABORT, 'ugc_submissions is append-only; update status instead');
END;

ALTER TABLE ugc_submission_upvotes
  ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1));

ALTER TABLE ugc_submission_flags
  ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1));

ALTER TABLE ugc_submission_votes
  ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1));

CREATE TRIGGER IF NOT EXISTS prevent_ugc_submission_upvotes_delete
BEFORE DELETE ON ugc_submission_upvotes
BEGIN
  SELECT RAISE(ABORT, 'ugc_submission_upvotes is append-only; set active = 0 instead');
END;

CREATE TRIGGER IF NOT EXISTS prevent_ugc_submission_flags_delete
BEFORE DELETE ON ugc_submission_flags
BEGIN
  SELECT RAISE(ABORT, 'ugc_submission_flags is append-only; set active = 0 instead');
END;

CREATE TRIGGER IF NOT EXISTS prevent_ugc_submission_votes_delete
BEFORE DELETE ON ugc_submission_votes
BEGIN
  SELECT RAISE(ABORT, 'ugc_submission_votes is append-only; set active = 0 instead');
END;

CREATE TRIGGER IF NOT EXISTS prevent_ugc_text_translations_delete
BEFORE DELETE ON ugc_text_translations
BEGIN
  SELECT RAISE(ABORT, 'ugc_text_translations is append-only');
END;
