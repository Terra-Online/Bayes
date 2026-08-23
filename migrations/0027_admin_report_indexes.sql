CREATE INDEX IF NOT EXISTS idx_ugc_text_translations_source_target
  ON ugc_text_translations(detected_source_language, source_language, target_language);

CREATE INDEX IF NOT EXISTS idx_ugc_text_translations_translated_at
  ON ugc_text_translations(translated_at);

CREATE INDEX IF NOT EXISTS idx_ugc_submission_upvotes_active_created
  ON ugc_submission_upvotes(active, created_at);

CREATE INDEX IF NOT EXISTS idx_ugc_submission_upvotes_active_submission
  ON ugc_submission_upvotes(active, submission_id);

CREATE INDEX IF NOT EXISTS idx_ugc_submission_votes_active_created
  ON ugc_submission_votes(active, created_at);
