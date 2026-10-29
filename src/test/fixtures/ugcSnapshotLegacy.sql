-- Synthetic historical data, including inactive interactions and read notifications.
INSERT INTO users(uid,email,password_hash,nickname,role)
VALUES ('owner','owner@example.invalid','','Owner','n'),
       ('reader','reader@example.invalid','','Reader','n');
INSERT INTO ugc_submissions
 (id,kind,poi_id,poi_hash,poi_type,user_id,snapshot_id,content,file_path,status,
  parent_id,comment_depth,created_at,updated_at,edit_original_content,
  edit_original_status,edit_original_snapshot_id,moderation_note)
VALUES
 ('comment-active','comment','poi','hash','type','owner','snap-comment-active','Current A',NULL,'active',NULL,0,'2025-01-01','2026-01-01','Discarded backup','active','discarded-id','Discarded note'),
 ('comment-flagged','comment','poi','hash','type','owner','snap-comment-flagged','Flagged',NULL,'flagged','comment-active',1,'2025-01-02','2026-01-01',NULL,NULL,NULL,NULL),
 ('comment-remove_request','comment','poi','hash','type','owner','snap-comment-remove_request','Keep public',NULL,'remove_request',NULL,0,'2025-01-03','2026-01-01',NULL,NULL,NULL,NULL),
 ('comment-stale','comment','poi','hash','type','owner','snap-comment-stale','Unknown',NULL,'stale',NULL,0,'2025-01-04','2026-01-01',NULL,NULL,NULL,NULL),
 ('image-active','image','poi','hash','type','owner','snap-image-active','Image','images/a.webp','active',NULL,0,'2025-01-05','2026-01-01',NULL,NULL,NULL,NULL),
 ('image-flagged','image','poi','hash','type','owner','snap-image-flagged',NULL,'images/b.webp','flagged',NULL,0,'2025-01-06','2026-01-01',NULL,NULL,NULL,NULL),
 ('image-remove_request','image','poi','hash','type','owner','snap-image-remove_request',NULL,'images/c.webp','remove_request',NULL,0,'2025-01-07','2026-01-01',NULL,NULL,NULL,NULL),
 ('image-stale','image','poi','hash','type','owner','snap-image-stale',NULL,'images/d.webp','stale',NULL,0,'2025-01-08','2026-01-01',NULL,NULL,NULL,NULL),
 ('image-pending_openai','image','poi','hash','type','owner','snap-image-pending_openai',NULL,'images/e.webp','pending_openai',NULL,0,'2025-01-09','2026-01-01',NULL,NULL,NULL,NULL),
 ('image-pending_audit','image','poi','hash','type','owner','snap-image-pending_audit',NULL,'images/f.webp','pending_audit',NULL,0,'2025-01-10','2026-01-01',NULL,NULL,NULL,NULL);
INSERT INTO ugc_submission_flags(submission_id,user_id,active)
VALUES ('comment-flagged','reader',1),('comment-active','reader',0),('image-stale','reader',1);
INSERT INTO ugc_submission_votes(submission_id,user_id,value,active)
VALUES ('comment-active','reader',-1,1),('comment-stale','reader',1,0);
INSERT INTO ugc_submission_upvotes(submission_id,user_id,active)
VALUES ('image-active','reader',1),('image-stale','reader',0);
INSERT INTO notifications
 (id,recipient_user_id,category,type,actor_user_id,submission_id,parent_submission_id,marker_id,dedupe_key,read_at)
VALUES ('unread','owner','community','community.comment.reply','reader','comment-flagged','comment-active','poi','fixture:unread',NULL),
 ('read','owner','system','system.remove_request.resolved',NULL,'image-stale',NULL,'poi','fixture:read','2026-02-01'),
 ('system','reader','system','system.submission.approved',NULL,'image-active',NULL,'poi','fixture:system',NULL);
INSERT INTO notification_messages
 (id,notification_id,submission_id,parent_submission_id,dedupe_key,created_at)
VALUES ('message','unread','comment-flagged','comment-active','fixture:message','2025-01-02');
INSERT INTO ugc_review_events(submission_id,snapshot_id,from_status,to_status,source,created_at)
VALUES ('comment-active','discarded-content','pending_audit','active','manual_moderation','2025-01-01');
