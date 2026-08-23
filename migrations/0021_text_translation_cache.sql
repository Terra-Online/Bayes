CREATE TABLE IF NOT EXISTS ugc_text_translations (
  cache_key TEXT PRIMARY KEY,
  text_hash TEXT NOT NULL,
  flow_version TEXT NOT NULL,
  source_language TEXT NOT NULL,
  detected_source_language TEXT,
  target_language TEXT NOT NULL,
  provider TEXT NOT NULL,
  glossary_version TEXT NOT NULL DEFAULT 'g0',
  glossary_key TEXT NOT NULL DEFAULT '',
  translated_content TEXT NOT NULL,
  glossary_applied INTEGER NOT NULL DEFAULT 0,
  translated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ugc_text_translations_flow_translated
  ON ugc_text_translations(flow_version, translated_at);

CREATE INDEX IF NOT EXISTS idx_ugc_text_translations_target_translated
  ON ugc_text_translations(target_language, translated_at);

CREATE INDEX IF NOT EXISTS idx_ugc_text_translations_text_target
  ON ugc_text_translations(text_hash, target_language, provider, glossary_version, glossary_key, translated_at);
