DROP TRIGGER IF EXISTS prevent_ugc_text_translations_delete;

DELETE FROM ugc_text_translations
WHERE lower(trim(source_language)) = lower(trim(target_language));

CREATE TRIGGER prevent_ugc_text_translations_delete
BEFORE DELETE ON ugc_text_translations
BEGIN
  SELECT RAISE(ABORT, 'ugc_text_translations is append-only');
END;

CREATE TRIGGER prevent_ugc_text_translations_same_language_insert
BEFORE INSERT ON ugc_text_translations
WHEN lower(trim(NEW.source_language)) = lower(trim(NEW.target_language))
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER prevent_ugc_text_translations_same_language_update
BEFORE UPDATE ON ugc_text_translations
WHEN lower(trim(NEW.source_language)) = lower(trim(NEW.target_language))
BEGIN
  SELECT RAISE(IGNORE);
END;
