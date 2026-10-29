const sql = (value) => (value == null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`);

/** One atomic local import. Identical syncs preserve history; changes append it.
 * Existing identity, ownership and creation time always belong to the first sync.
 */
export function buildDemoImageSql(image, userId) {
  const id = `demo_r2_${image.id}`;
  const filePath = decodeURIComponent(new URL(image.url).pathname.replace(/^\/+/, ""));
  const createdAt = image.createdAt || new Date().toISOString();
  const content = sql(image.content);
  const size = Number(image.localSize ?? 0);
  return `
    INSERT INTO ugc_submissions
      (id,kind,poi_id,poi_hash,poi_type,user_id,created_at,updated_at)
    VALUES (${sql(id)},'image',${sql(image.markerId)},${sql(image.markerId)},'demo',${sql(userId)},${sql(createdAt)},${sql(createdAt)})
    ON CONFLICT(id) DO NOTHING;

    INSERT INTO ugc_snapshots
      (id,submission_id,kind,revision,content,file_path,mime_type,size_bytes,review_status,creator_user_id,created_at)
    SELECT s.id || '-r' || (s.revision + CASE WHEN f.id IS NULL THEN 0 ELSE 1 END),
      s.id,'image',s.revision + CASE WHEN f.id IS NULL THEN 0 ELSE 1 END,
      ${content},${sql(filePath)},'image/webp',${size},'approved',s.user_id,${sql(createdAt)}
    FROM ugc_submissions s LEFT JOIN ugc_snapshots f ON f.submission_id=s.id AND f.revision=s.revision
    WHERE s.id=${sql(id)} AND s.user_id=${sql(userId)} AND s.kind='image'
      AND (f.id IS NULL OR f.content IS NOT ${content} OR f.file_path IS NOT ${sql(filePath)}
        OR f.mime_type IS NOT 'image/webp' OR f.size_bytes IS NOT ${size});

    UPDATE ugc_submissions SET revision=revision+1,updated_at=${sql(createdAt)}
    WHERE id=${sql(id)} AND EXISTS (SELECT 1 FROM ugc_snapshots
      WHERE submission_id=${sql(id)} AND revision=ugc_submissions.revision+1);
  `;
}
