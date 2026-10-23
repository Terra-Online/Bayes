ALTER TABLE worker_errors
  ADD COLUMN error_reasons_json TEXT NOT NULL DEFAULT '[]';
