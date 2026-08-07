CREATE TABLE IF NOT EXISTS worker_errors (
  id TEXT PRIMARY KEY,
  event_timestamp_ms INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  script_name TEXT,
  event_type TEXT,
  method TEXT,
  url TEXT,
  status INTEGER,
  outcome TEXT NOT NULL,
  ray_id TEXT,
  request_id TEXT,
  exception_count INTEGER NOT NULL DEFAULT 0,
  error_log_count INTEGER NOT NULL DEFAULT 0,
  cpu_time_ms INTEGER,
  wall_time_ms INTEGER,
  truncated INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_worker_errors_event_timestamp
  ON worker_errors(event_timestamp_ms);

CREATE INDEX IF NOT EXISTS idx_worker_errors_ray_id
  ON worker_errors(ray_id);
