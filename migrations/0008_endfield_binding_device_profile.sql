ALTER TABLE endfield_bindings ADD COLUMN device_profile TEXT;

WITH assigned AS (
  SELECT
    uid,
    lower(hex(randomblob(16))) AS device_id,
    (ROW_NUMBER() OVER (ORDER BY uid) - 1) % 9 AS profile_index
  FROM endfield_bindings
  WHERE device_profile IS NULL OR trim(device_profile) = ''
)
UPDATE endfield_bindings
SET device_profile = (
  SELECT CASE profile_index
    WHEN 0 THEN '{"version":1,"platform":"ios","deviceModel":"iPhone 17 Pro","osVersion":"iOS 26.4","deviceType":"7","deviceId":"' || device_id || '","userAgent":"Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1"}'
    WHEN 1 THEN '{"version":1,"platform":"android","deviceModel":"SM-S9480","osVersion":"Android 16","deviceType":"7","deviceId":"' || device_id || '","userAgent":"Mozilla/5.0 (Linux; Android 16; SM-S9480) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36","secChUa":"\"Chromium\";v=\"148\", \"Google Chrome\";v=\"148\", \"Not?A_Brand\";v=\"99\"","secChUaMobile":"?1","secChUaPlatform":"\"Android\""}'
    WHEN 2 THEN '{"version":1,"platform":"ios","deviceModel":"iPad Pro","osVersion":"iPadOS 26.4","deviceType":"7","deviceId":"' || device_id || '","userAgent":"Mozilla/5.0 (iPad; CPU OS 26_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1"}'
    WHEN 3 THEN '{"version":1,"platform":"ios","deviceModel":"iPhone 16 Pro","osVersion":"iOS 26.3","deviceType":"7","deviceId":"' || device_id || '","userAgent":"Mozilla/5.0 (iPhone; CPU iPhone OS 26_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1"}'
    WHEN 4 THEN '{"version":1,"platform":"android","deviceModel":"Xiaomi 15 Pro","osVersion":"Android 15","deviceType":"7","deviceId":"' || device_id || '","userAgent":"Mozilla/5.0 (Linux; Android 15; Xiaomi 15 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36","secChUa":"\"Chromium\";v=\"136\", \"Google Chrome\";v=\"136\", \"Not?A_Brand\";v=\"99\"","secChUaMobile":"?1","secChUaPlatform":"\"Android\""}'
    WHEN 5 THEN '{"version":1,"platform":"ios","deviceModel":"iPhone 15 Pro","osVersion":"iOS 17.5","deviceType":"7","deviceId":"' || device_id || '","userAgent":"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"}'
    WHEN 6 THEN '{"version":1,"platform":"android","deviceModel":"CPH2581","osVersion":"Android 14","deviceType":"7","deviceId":"' || device_id || '","userAgent":"Mozilla/5.0 (Linux; Android 14; CPH2581) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36","secChUa":"\"Chromium\";v=\"124\", \"Google Chrome\";v=\"124\", \"Not?A_Brand\";v=\"99\"","secChUaMobile":"?1","secChUaPlatform":"\"Android\""}'
    WHEN 7 THEN '{"version":1,"platform":"windows","deviceModel":"Windows PC","osVersion":"Windows 11","deviceType":"7","deviceId":"' || device_id || '","userAgent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36","secChUa":"\"Chromium\";v=\"148\", \"Google Chrome\";v=\"148\", \"Not?A_Brand\";v=\"99\"","secChUaMobile":"?0","secChUaPlatform":"\"Windows\""}'
    ELSE '{"version":1,"platform":"windows","deviceModel":"Windows PC","osVersion":"Windows 11","deviceType":"7","deviceId":"' || device_id || '","userAgent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0","secChUa":"\"Chromium\";v=\"142\", \"Microsoft Edge\";v=\"142\", \"Not?A_Brand\";v=\"99\"","secChUaMobile":"?0","secChUaPlatform":"\"Windows\""}'
  END
  FROM assigned
  WHERE assigned.uid = endfield_bindings.uid
)
WHERE uid IN (SELECT uid FROM assigned);
