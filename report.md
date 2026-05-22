# Bayes 後端安全審計與上線前評估報告

版本：v1.0  
日期：2026-04-16  
審計範圍：整個後端倉庫（程式碼、遷移、部署設定、文檔）  
審計方式：以程式碼證據為主，補充推定風險與待線上驗證項目

---

## 一、執行摘要

本次審計發現目前系統整體架構清晰（Hono + Workers + D1 + R2 + Redis + Better Auth），但在「上線安全穩定性」上存在幾個高優先風險：

1. 認證與會話層存在資訊洩漏與安全預設問題（例如使用者存在性回應、開發密鑰 fallback）。
2. Redis-first 的進度同步與 upload ticket 消費缺少原子性與冪等設計，存在競態和重試風暴風險。
3. 外部依賴失敗（OpenAI/Redis/Resend）時的降級策略會導致審核繞過或核心功能不可用。
4. 缺少上線級的備援恢復、審計追蹤、CI/CD 安全與環境隔離證據。

風險分級統計（按 checklist 項目）：
- High：24
- Medium：37
- Low：11

---

## 二、實際系統網路流程（上線視角）

### 2.1 主請求流（Client -> Edge -> Backend）

1. Client 送請求到 Cloudflare Worker（[src/index.ts](src/index.ts)、[src/app.ts](src/app.ts)）。
2. 全域中介層依序處理：request id、CORS、error handler（[src/app.ts](src/app.ts)）。
3. 路由層進入對應模組（auth/progress/uploads/moderation/health）。
4. 需要登入的路徑由 requireAuth 解析 Better Auth session（[src/middleware/auth.ts](src/middleware/auth.ts)）。
5. 業務資料讀寫至 D1、Redis、R2，或呼叫 OpenAI/Resend。

### 2.2 Auth 流

1. /auth/v1/register：先走 OTP sign-in，再 setPassword（[src/routes/auth.ts](src/routes/auth.ts)）。
2. /auth/v1/sign-in/email 與 /auth/v1/forget-password 透過代理轉發到 Better Auth。
3. /auth/v1/session 走 requireAuth，回傳業務 user payload。
4. 依賴：Better Auth + D1 + Resend。

### 2.3 Progress Sync 流

1. /progress/v1/state：先讀 Redis，miss 再回源 D1 並回填（[src/services/progress.ts](src/services/progress.ts)）。
2. /progress/v1/sync：比較版本後寫 Redis + dirty set + points delta。
3. scheduled cron 每 5 分鐘 flush dirty users 到 D1（[src/index.ts](src/index.ts)）。

### 2.4 Upload + Moderation 流

1. /uploads/v1/presign 建立 ticket（Redis）與 objectKey（R2 path）。
2. /uploads/v1/direct/:ticketId 消費 ticket，上傳 R2，寫入 ugc_submissions。
3. 提交加入 moderation queue（Redis list）。
4. cron 或 /moderation/v1/run-once 消費 queue，調 OpenAI moderation，更新 audit_status。

### 2.5 背景作業流

1. scheduled 觸發 runScheduledJobs：flush progress -> backfill moderation queue -> moderate once。
2. 沒有觀察到完整重試佇列、死信隊列或作業級告警閾值。

---

## 三、全量 Checklist 審計結果

說明：以下每列都包含你要求欄位 category/item/risk_level/issue/exploit_scenario/impact/recommendation。

## 3.1 Scope & Asset Inventory

| category | item | risk_level | issue | exploit_scenario | impact | recommendation |
|---|---|---|---|---|---|---|
| Scope & Asset Inventory | Enumerate all API endpoints (public and authenticated) | Low | 路由已集中於 [src/app.ts](src/app.ts) 與 routes 模組，但 README 與實際 proxy 路由可能出現認知落差。 | 攻擊者比文檔多探測到未明確揭示的 auth 代理路徑。 | 安全面盤點不完整，遺漏防護。 | 建立自動化 OpenAPI 產生與發版比對，防止端點漂移。 |
| Scope & Asset Inventory | Map data flow between client, edge, backend, and storage | Medium | 有實作但缺少正式資料流文檔（特別是 cron/queue 寫回）。 | 上線後 incident 時無法快速定位資料在哪一層遺失。 | 故障排查時間長，恢復慢。 | 製作常態化資料流圖與故障切面圖，納入 runbook。 |
| Scope & Asset Inventory | Identify all external dependencies | Medium | 依賴 Better Auth/OpenAI/Resend/Upstash/Cloudflare，未見依賴失效矩陣。 | 第三方局部故障時錯誤降級（如審核直接放行）。 | 審核與認證流程可被外部故障放大。 | 建立 dependency failure matrix（fail-open/fail-close 明確化）。 |
| Scope & Asset Inventory | Define trust boundaries | High | 邊界定義有缺口：IP 信任含 x-forwarded-for（[src/middleware/rate-limit.ts](src/middleware/rate-limit.ts#L55)），trustedOrigins 寫死 localhost（[src/lib/auth.ts](src/lib/auth.ts#L152)）。 | 攻擊者偽造來源 IP 或利用部署配置失配。 | 速率限制與跨域邊界失真。 | 只信任 cf-connecting-ip；trustedOrigins/CORS 改環境變數白名單。 |

## 3.2 Authentication & Authorization

| category | item | risk_level | issue | exploit_scenario | impact | recommendation |
|---|---|---|---|---|---|---|
| Authentication & Authorization | Session lifecycle (TTL, revoke, multi-device) | Medium | 會話策略主要依賴 Better Auth 預設，未見多裝置撤銷策略與 session 風險告警。 | 被盜 session 在有效期內可持續存取。 | 帳號被長時間劫持。 | 增加 session 管理端點、裝置清單與異常登入告警。 |
| Authentication & Authorization | Token security (HttpOnly, Secure, SameSite) | High | secret 存在開發 fallback（[src/lib/auth.ts](src/lib/auth.ts#L12)、[src/lib/auth.ts](src/lib/auth.ts#L151)）。 | 生產環境漏設 secret 時可用固定密鑰偽造 token。 | 認證邊界可被突破。 | 生產環境強制 secret 必填；啟動時 fail-fast。 |
| Authentication & Authorization | OTP system (replay, brute force protection) | High | OTP 有限流，但存在帳號存在性洩漏訊號（例如 sign-in/email 的 USER_NOT_FOUND，[src/routes/auth.ts](src/routes/auth.ts#L409)）。 | 攻擊者先枚舉有效信箱，再集中 OTP 嘗試。 | 帳戶接管成功率上升。 | 統一模糊化回應；補 user+IP 雙維度 OTP 失敗計數與退避。 |
| Authentication & Authorization | Authorization checks (IDOR, privilege escalation) | Medium | 角色檢查有做，但 moderation 更新缺少審計歸屬資訊。 | 具 moderator 角色者可覆蓋他人審核結果，追責困難。 | 權限濫用難追蹤。 | 增加 moderation_audit（actor、old/new status、timestamp、reason）。 |
| Authentication & Authorization | Unauthenticated access paths | Medium | auth 模組有多條 raw forward 路徑（如 callback/error/get-session/sign-out）。 | 攻擊者可大量打未授權端點做探測與資源消耗。 | 外圍攻擊面增加。 | 為高頻未授權端點加細粒度限流與行為監測。 |

## 3.3 API Security

| category | item | risk_level | issue | exploit_scenario | impact | recommendation |
|---|---|---|---|---|---|---|
| API Security | Input validation (type, length, schema) | Medium | 主要端點有 zod，但仍有代理轉發路徑依賴下游校驗。 | 惡意 payload 進入下游 auth handler，造成非預期錯誤。 | 例外路徑增多、可用性下降。 | 代理入口也加最小 schema 驗證與 body size 限制。 |
| API Security | Injection risks (SQL, JSON, command) | Low | SQL 基本採參數化，未見 command injection。 | 攻擊者嘗試 SQL/命令注入未直接成功。 | 目前主要是低風險。 | 保持參數化，補上 WAF 規則與 payload 稽核。 |
| API Security | Replay attacks and duplicate submissions | High | upload direct 與 progress sync 缺少 idempotency key。 | 網路抖動重試導致重複寫入/重複提交。 | 資料重複、積分異常、審核壓力。 | 所有寫入端點引入 Idempotency-Key + 去重儲存。 |
| API Security | Race conditions and concurrency issues | High | upload ticket 消費是 GET 再 DEL（[src/services/upload.ts](src/services/upload.ts#L63)、[src/services/upload.ts](src/services/upload.ts#L68)）；progress 讀比寫非原子。 | 並發請求同時通過檢查，造成雙寫。 | 一致性破壞。 | 改用原子操作（如 GETDEL/Lua/CAS）與版本鎖。 |
| API Security | Rate limiting and abuse protection | Medium | 限流依賴 Redis 與 IP，且 IP 來源可被 x-forwarded-for 影響。 | 攻擊者輪換/偽造 IP 進行壓測與撞庫。 | 風控效果下降。 | 僅信任 CF IP；加入 user/device/token 維度限流。 |
| API Security | Idempotency of write operations | High | 目前 write API 普遍無冪等語義。 | 客戶端 retry storm 造成寫入放大。 | 服務壓力與資料污染。 | 定義冪等策略：submission、sync、status update 全部支持。 |

## 3.4 Data Layer

| category | item | risk_level | issue | exploit_scenario | impact | recommendation |
|---|---|---|---|---|---|---|
| Data Layer | Data consistency between cache and database | High | progress 採 Redis-first + cron flush，非同步最終一致。 | Redis 狀態與 D1 暫時分叉，遇故障放大為永久分叉。 | 用戶進度/積分不一致。 | 增加 flush 事務保護、重試與一致性校驗任務。 |
| Data Layer | Partial write / failure handling | High | upload 流程先 put R2 後寫 D1，任何一步失敗可能殘留。 | R2 成功但 D1 寫失敗，形成孤兒物件。 | 儲存成本與資料治理問題。 | 引入 saga 補償（失敗清理 R2）與重試隊列。 |
| Data Layer | Data isolation between users | Medium | 應用層多數按 uid 隔離，但 Redis key 命名可預測。 | 內部失誤或憑證外洩時，橫向讀取更容易。 | 橫向資料風險升高。 | key namespace 加 salt/tenant，限制 token 權限。 |
| Data Layer | Encryption in transit and at rest | Medium | 主要依賴平台默認加密，程式未明確 HSTS/TLS 強制策略。 | 中間環節配置失當時降級傳輸。 | 敏感資料暴露機率增加。 | 在 edge 層明確啟用 HSTS、TLS only、加密審核清單。 |
| Data Layer | Data lifecycle (TTL, deletion, export) | Medium | 有 TTL（progress/ticket）但缺完整刪除/匯出流程。 | 法規請求（刪除/匯出）無法按 SLA 完成。 | 合規風險。 | 建立 DSAR 流程與資料生命週期作業。 |

## 3.5 Cache & State (Redis)

| category | item | risk_level | issue | exploit_scenario | impact | recommendation |
|---|---|---|---|---|---|---|
| Cache & State (Redis) | Key design (predictable or enumerable) | Medium | key 格式固定可預測，如 user:progress:uid、upload:ticket:id。 | 憑證外洩或內部誤用時，批量列舉更容易。 | 放大資料外洩半徑。 | key 加前綴隔離（env/app/version）與最小權限 token。 |
| Cache & State (Redis) | TTL and expiration correctness | Medium | progress TTL 較長、dirty/points TTL 與 flush 節奏耦合。 | 過期時機與 flush 失配導致資料回滾或遺失。 | 一致性下降。 | 重新設計 TTL 與 flush 週期，加入過期前預寫機制。 |
| Cache & State (Redis) | Data pollution risks | Medium | 未見針對異常 key/value 的隔離機制。 | 惡意/錯誤 payload 汙染快取並持續影響讀路徑。 | 髒資料擴散。 | 增加 schema 驗證、版本號與清理任務。 |
| Cache & State (Redis) | Failure behavior when cache is unavailable | High | 限流、票證、進度都依賴 Redis，無完整降級策略。 | Redis outage 期間大量 5xx 或功能不可用。 | 可用性重大風險。 | 設計 fail-open/fail-close 分級策略與熔斷開關。 |
| Cache & State (Redis) | Batch write-back consistency | High | flushDirtyProgressToD1 無完整事務包裝與重試記錄。 | 部分成功後中斷造成重複加點或遺失。 | 核心業務資料失真。 | 以 job ledger 記錄每次 flush，確保 exactly-once 或可補償。 |

## 3.6 Edge & Network

| category | item | risk_level | issue | exploit_scenario | impact | recommendation |
|---|---|---|---|---|---|---|
| Edge & Network | Request flow: client → edge → backend | Medium | 流程存在但未產品化為 runbook。 | 攻擊/故障時無法快速定位在哪層失效。 | MTTR 增加。 | 維護 edge/backend/storage 逐跳觀測儀表板。 |
| Edge & Network | Header trust (X-Forwarded-For, IP spoofing) | High | 同時信任 x-forwarded-for（[src/middleware/rate-limit.ts](src/middleware/rate-limit.ts#L55)）。 | 攻擊者偽造 IP 繞過 IP 限流。 | 風控繞過。 | 僅信任 cf-connecting-ip；禁止 client 控制 IP header。 |
| Edge & Network | CORS configuration | Medium | CORS origin 寫死 localhost 且 credentials=true（[src/app.ts](src/app.ts#L19)、[src/app.ts](src/app.ts#L22)）。 | 生產環境配置錯誤時要嘛全擋合法流量，要嘛過度開放。 | 可用性與安全性同時受影響。 | 用環境白名單與部署檢查，拒絕 wildcard + credentials。 |
| Edge & Network | HTTPS enforcement and TLS security | Medium | 未在應用層看到 HSTS/強制 HTTPS 策略聲明。 | 錯誤網域或代理配置下可能發生降級。 | 傳輸安全風險。 | 補 HSTS、TLS policy，納入上線檢查。 |
| Edge & Network | Cache poisoning risks | Low | 未見明確 public cache 邏輯，風險較低。 | 若後續接 CDN cache 而不分 Vary，可能被汙染。 | 目前低，未來可升高。 | 預先定義 cache key 與敏感路徑 no-store。 |
| Edge & Network | Exposure of internal/debug endpoints | Medium | 存在 root 與 health 公開端點（[src/app.ts](src/app.ts)、[src/routes/health.ts](src/routes/health.ts)）。 | 攻擊者可用於存活探測與節點掃描。 | 偵察風險。 | 對 health 增加最小資訊回應與速率限制。 |

## 3.7 Third-party Dependencies

| category | item | risk_level | issue | exploit_scenario | impact | recommendation |
|---|---|---|---|---|---|---|
| Third-party Dependencies | Email service abuse (spam, bombing) | Medium | OTP 端點可被濫用，雖有限流但仍可做分散轟炸。 | 多 IP/代理池對同域信箱連續發送。 | 郵件成本與聲譽受損。 | 加入 domain/risk score 限制與灰名單。 |
| Third-party Dependencies | Callback endpoint validation | Medium | callback 路徑轉發依賴 Better Auth，應用層未額外驗證來源策略。 | 惡意構造 callback 參數打穿弱配置。 | OAuth 流程風險上升。 | 強化 callback allowlist 與 state/nonce 稽核。 |
| Third-party Dependencies | Default security of auth frameworks | Medium | 對 Better Auth 預設依賴重，且 local trustedOrigins 固定。 | 部署不當時預設值進入生產。 | 認證策略偏弱。 | 明確寫入 production-only config 與啟動檢查。 |
| Third-party Dependencies | API key and secret management | High | auth secret 可 fallback、OPENAI 可缺省放行審核。 | 環境變數漏設造成安全降級。 | 核心邊界受損。 | 生產必填 secret/key，缺失即拒絕啟動。 |
| Third-party Dependencies | Failure impact of external services | High | OpenAI 失敗回 fallback pass（[src/services/moderation.ts](src/services/moderation.ts#L82)）。 | 審核服務暫停時內容自動放行。 | 內容安全失控。 | 改 fail-close 或 pending + retry，不得自動放行。 |

## 3.8 Client Bypass

| category | item | risk_level | issue | exploit_scenario | impact | recommendation |
|---|---|---|---|---|---|---|
| Client Bypass | Direct API access without frontend | High | 攻擊者可直接打 API，部分端點仍會回傳可枚舉訊息。 | 腳本直接枚舉信箱、轟炸 OTP、重試 upload/sync。 | 風險集中在 API 層。 | 所有安全控制必須後端強制，且統一回應策略。 |
| Client Bypass | Authorization enforced only on frontend | Low | 目前授權主要在後端 middleware，非純前端控制。 | 嘗試略過前端直接呼叫 protected route 會被擋。 | 目前此項低風險。 | 持續透過整合測試驗證路由守衛。 |
| Client Bypass | Parameter tampering | Medium | markerId/content/mime 有檢查，但業務語義驗證不足。 | 篡改 markerId 對不存在點位提交垃圾資料。 | 內容品質與資源消耗問題。 | 加 marker whitelist/存在性驗證與 anti-abuse 規則。 |
| Client Bypass | Unauthorized resource access | Medium | /reset-password-preview 會回 email（[src/routes/auth.ts](src/routes/auth.ts#L521)）。 | 透過 token 探測可確認帳號關聯。 | 個資洩漏與社工風險。 | 預覽端點只回 generic 狀態，不回 email。 |

## 3.9 Concurrency & Failure Scenarios

| category | item | risk_level | issue | exploit_scenario | impact | recommendation |
|---|---|---|---|---|---|---|
| Concurrency & Failure Scenarios | Concurrent writes to same resource | High | progress 版本比對與寫入非原子。 | 兩個客戶端同時 sync，後寫覆蓋前寫。 | 進度回退或加點異常。 | 以 CAS/Lua/transaction-like 流程保證原子。 |
| Concurrency & Failure Scenarios | Duplicate requests (retry storms) | High | 缺少通用冪等鍵。 | 行動網路抖動造成同一操作多次提交。 | 重複資料與隊列膨脹。 | 統一 retry-safe API 契約與 server 去重存儲。 |
| Concurrency & Failure Scenarios | Partial failures (cache success, DB fail) | High | 跨 Redis/D1/R2/3rd party 無 saga。 | 任一步驟失敗後留下半完成狀態。 | 需要人工修復、數據偏差。 | 引入補償交易、重試與死信隊列。 |
| Concurrency & Failure Scenarios | External service downtime handling | High | OpenAI fail-open；Redis/Resend outage 缺清晰策略。 | 第三方短暫故障轉成業務級事故。 | 安全與可用性同時受損。 | 定義逐依賴降級政策與熔斷告警。 |
| Concurrency & Failure Scenarios | Data loss scenarios | High | 未見備份恢復演練、RPO/RTO 指標。 | D1/R2/Redis 任何層資料異常時無明確恢復路徑。 | 資料永久遺失風險。 | 建立備份與恢復演練制度，定期演練。 |

## 3.10 Observability & Logging

| category | item | risk_level | issue | exploit_scenario | impact | recommendation |
|---|---|---|---|---|---|---|
| Observability & Logging | Sensitive data in logs | Medium | 5xx log 可能攜帶 rawError/details（[src/middleware/error-handler.ts](src/middleware/error-handler.ts)）。 | 異常內容含敏感欄位時被日志系統長期保存。 | 個資與安全資訊暴露。 | 建立 log redaction（email/token/body）規則。 |
| Observability & Logging | Audit trail completeness | High | moderation 狀態更新缺 actor/前後值審計表。 | 內部濫用無法追責。 | 合規與治理不足。 | 建立不可篡改 audit_log 表。 |
| Observability & Logging | Monitoring coverage | Medium | 目前以 console 為主，缺關鍵 SLI/SLO 指標。 | 風險事件無法即時識別。 | 偵測延遲。 | 接入 metrics/trace，建立成功率、延遲、隊列深度指標。 |
| Observability & Logging | Alerting effectiveness | Medium | 未見告警規則。 | 大量 429/5xx、queue 堆積時無人值守告警。 | 事故擴大。 | 設置閾值告警與 on-call runbook。 |
| Observability & Logging | Traceability of requests | Low | 有 request-id（[src/middleware/request-id.ts](src/middleware/request-id.ts)）但跨服務串接不足。 | 跨第三方追查仍斷鏈。 | 調查成本增加。 | 導入端到端 trace id（含 OpenAI/Resend 關聯）。 |

## 3.11 Abuse & Rate Limiting

| category | item | risk_level | issue | exploit_scenario | impact | recommendation |
|---|---|---|---|---|---|---|
| Abuse & Rate Limiting | Rate limiting strategy | Medium | 分鐘級固定窗口，缺動態風控。 | 攻擊者在窗口邊界突刺流量。 | 服務壓力升高。 | 改 sliding window/token bucket + 風險分數。 |
| Abuse & Rate Limiting | IP vs user-level throttling | High | 以 IP 為主，缺 user/device 維度。 | NAT 或代理環境下誤封/漏封並存。 | 風控精準度不足。 | 建立 IP + user + endpoint 複合限流。 |
| Abuse & Rate Limiting | Bot detection | Medium | 無 bot challenge/行為指紋。 | 腳本可持續打公開端點。 | 被動防禦壓力增大。 | 導入 bot 管理（Turnstile/風險挑戰）。 |
| Abuse & Rate Limiting | Resource exhaustion protection | Medium | upload 有大小限制但缺隊列背壓與全局並發閾值。 | 大量合法格式大檔耗盡 R2/CPU。 | 成本與可用性風險。 | 設定全域併發上限與 per-user 上傳配額。 |

## 3.12 Deployment & Secrets

| category | item | risk_level | issue | exploit_scenario | impact | recommendation |
|---|---|---|---|---|---|---|
| Deployment & Secrets | Environment isolation (dev/staging/prod) | High | wrangler 設定未見完整多環境區隔證據（[wrangler.toml](wrangler.toml)）。 | 測試配置誤用到生產。 | 安全與資料隔離失效。 | 建立多環境 wrangler/env 與資源獨立命名。 |
| Deployment & Secrets | Secrets management | High | 關鍵 secret 存 fallback 行為。 | 部署漏設 secret 被忽略，服務仍啟動。 | 認證強度下降。 | 改為必填 + 啟動檢查 + 定期輪換。 |
| Deployment & Secrets | CI/CD pipeline security | Medium | 倉庫未見 CI/CD 安全流程證據。 | 人工部署導致未測試代碼上線。 | 發版風險高。 | 建立 pipeline：lint/type/test/security scan + 審批。 |
| Deployment & Secrets | Dependency vulnerabilities | Medium | 未見自動化依賴掃描與阻斷策略。 | 已知漏洞套件進入生產。 | 供應鏈風險。 | 啟用 npm audit/SCA + PR gate。 |
| Deployment & Secrets | Build integrity | Medium | 有 lockfile，但未見簽章與可重現 build 證據。 | 供應鏈污染難追溯。 | 完整性風險。 | 加入可重現建置與產物簽名。 |

## 3.13 Backup & Recovery

| category | item | risk_level | issue | exploit_scenario | impact | recommendation |
|---|---|---|---|---|---|---|
| Backup & Recovery | Backup strategy | High | 程式碼層未見 D1/R2/Redis 備份策略證據。 | 資料庫誤刪或污染後無法快速回復。 | 重大資料遺失。 | 定義備份頻率、保留期、加密與跨區策略。 |
| Backup & Recovery | Recovery testing | High | 未見恢復演練紀錄。 | 備份可用性未知，災難時失效。 | RTO 不可控。 | 每季演練恢復並產出演練報告。 |
| Backup & Recovery | RPO/RTO definition | High | 未見正式 RPO/RTO 指標。 | 事故時無決策基準。 | 業務溝通與恢復混亂。 | 定義並公告 RPO/RTO，對齊產品承諾。 |
| Backup & Recovery | Disaster recovery readiness | High | 未見 DR runbook（區域故障、第三方中斷）。 | 大範圍故障無標準流程。 | 長時間停機。 | 建立 DR runbook 與演練值班機制。 |

## 3.14 Compliance & Privacy

| category | item | risk_level | issue | exploit_scenario | impact | recommendation |
|---|---|---|---|---|---|---|
| Compliance & Privacy | User data handling | Medium | 處理 email、session、UGC，但資料分類與最小化策略未文件化。 | 事件時難界定敏感資料邊界。 | 合規壓力上升。 | 建立資料分類分級與最小化收集原則。 |
| Compliance & Privacy | Data deletion capability | High | 未見使用者資料刪除流程/端點。 | 用戶提出刪除請求無法按時履行。 | 法規違反風險。 | 建立刪除流程：auth/users/submissions/R2/Redis 全鏈路。 |
| Compliance & Privacy | Data export capability | High | 未見資料匯出機制。 | 用戶資料可攜請求無法完成。 | 合規與信任風險。 | 提供使用者資料匯出 API 與審計。 |
| Compliance & Privacy | Cross-border data considerations | Medium | OpenAI/Resend/Cloudflare 可能涉跨境，未見資料區域策略。 | 不同法域下觸發資料傳輸限制。 | 法規風險。 | 建立跨境資料清單與法務審核流程。 |

## 3.15 Threat Modeling

| category | item | risk_level | issue | exploit_scenario | impact | recommendation |
|---|---|---|---|---|---|---|
| Threat Modeling | Account takeover paths | High | 存在使用者枚舉與 OTP/重設流程資訊回應風險。 | 攻擊者先枚舉信箱再針對性撞庫/社工。 | 帳戶接管風險升高。 | 統一模糊回應、加風險挑戰與登入異常告警。 |
| Threat Modeling | Privilege escalation paths | Medium | 角色檢查有做，但缺審計與職責分離證據。 | 內部帳號濫用 moderation 權限。 | 內容治理失真。 | 加 RBAC 審計、最小權限與操作審批。 |
| Threat Modeling | API abuse paths | High | upload/sync/otp 皆可被腳本化濫用。 | 批量重試與併發請求造成資源放大。 | 成本、可用性、資料品質受損。 | 建立 abuse playbook 與自動封鎖規則。 |
| Threat Modeling | Resource exhaustion attacks | High | 缺全局背壓與 bot 防護。 | 攻擊者以合法格式高頻大檔打滿系統。 | 服務降級或中斷。 | 全局配額、排隊與限速、異常流量黑洞。 |
| Threat Modeling | Lateral movement possibilities | Medium | 若任一第三方或憑證洩漏，Redis 可預測 key 會放大橫向風險。 | 取得部分權限後擴散到更多資料面。 | 事故半徑擴大。 | 分層憑證、最小權限、key 隔離與密鑰輪換。 |

---

## 四、真實高風險攻擊/故障劇本（節選）

### 劇本 A：帳號枚舉 + 定向攻擊

1. 攻擊者對 /auth/v1/sign-in/email 輸入字典信箱。  
2. 根據 USER_NOT_FOUND 與其他回應差異判斷帳號存在。  
3. 對有效信箱發起 OTP/忘記密碼轟炸與社工。  

影響：提高帳號接管成功率、傷害郵件聲譽與用戶信任。

### 劇本 B：Upload Ticket 並發消費

1. 同一 ticketId 并發發送兩個 direct upload。  
2. consume 流程 GET -> DEL 非原子，兩請求都可能讀到 ticket。  
3. 形成重複提交與審核隊列膨脹。  

影響：資料重複、審核負擔、成本上升。

### 劇本 C：Progress 重試風暴與分叉

1. 客戶端網路不穩，多次重試 /progress/v1/sync。  
2. 缺冪等鍵與原子 compare-and-set，造成版本競爭。  
3. cron flush 遇部分失敗導致重複加點或回退。  

影響：核心業務數據失真，玩家糾紛。

### 劇本 D：OpenAI 故障導致審核放行

1. moderation 呼叫 OpenAI 返回非 2xx。  
2. 程式將結果視為 fallback pass（clean）。  
3. 敏感內容在第三方故障期間被自動通過。  

影響：內容安全事故與品牌風險。

---

## 五、實際上線步驟與工作方式（建議）

## 5.1 發版前（Pre-release）

1. 環境隔離檢查：dev/staging/prod 各自 D1、R2、Redis、Secrets。  
2. 秘密檢查：BETTER_AUTH_SECRET、UPSTASH、OPENAI、RESEND 必填且輪換日期有效。  
3. DB 遷移演練：先 staging 套用 migrations，再做讀寫回歸。  
4. 安全閘門：lint、typecheck、依賴掃描、關鍵 API smoke test。  
5. 風險開關：準備 fail-close/fail-open 的緊急切換策略。

建議命令（示意）：

```bash
pnpm run lint
pnpm run typecheck
pnpm run db:migrate:remote
```

## 5.2 發版中（Release）

1. 先部署 staging，執行端到端冒煙：auth、progress、upload、moderation。  
2. 小流量灰度到 production。  
3. 監看 5xx、429、Redis latency、moderation queue depth。  
4. 達閾值立即回滾（代碼回滾 + schema 相容策略）。

## 5.3 發版後（Post-release）

1. 每 15 分鐘巡檢：queue backlog、cron 成功率、D1 寫入錯誤。  
2. 每日稽核：審核決策分佈、OTP 發送異常、IP 濫用。  
3. 每週檢查：依賴漏洞、secret 輪換、成本異常。  
4. 每月演練：故障注入（Redis/OpenAI/Resend）與恢復演練。

---

## 六、優先修補路線圖（P0/P1/P2）

### P0（立即，1-3 天）

1. 移除 auth secret fallback，生產必填。  
2. 收斂使用者存在性回應（sign-in/reset preview）。  
3. moderation 改為 fail-close 或 pending-retry，不可 fallback pass。  
4. upload ticket 消費改原子操作，補 direct upload 冪等。

### P1（短期，1-2 週）

1. progress sync 引入 CAS/冪等鍵，修正 flush 補償機制。  
2. 限流改成 IP+user 複合策略，僅信任 cf-connecting-ip。  
3. 建立 moderation/user 安全審計表。  
4. CORS/trustedOrigins 改由環境變數管理。

### P2（中期，2-4 週）

1. 完整 observability（metrics + alerts + trace）。  
2. 建立 backup/recovery/DR runbook 並演練。  
3. 建立 DSAR（資料刪除與匯出）與跨境資料治理。  
4. CI/CD 安全閘門與供應鏈完整性（掃描、簽章）。

---

## 七、待線上驗證項目（需要雲端控制台/運維證據）

1. Cloudflare TLS 與 HSTS 是否強制。  
2. D1/R2 備份策略與恢復演練紀錄。  
3. Upstash 網路 ACL、token 權限與輪換策略。  
4. Resend/OpenAI 生產配額、速率限制與失敗告警。  
5. 生產環境 wrangler secrets 是否完整且無 fallback 啟動。

建議驗證方式（示意）：

```bash
# 檢查 wrangler 綁定與環境
wrangler deployments list
wrangler secret list

# 驗證關鍵健康端點
curl -i https://<prod-domain>/health/v1/status

# 驗證高風險流程（staging）
curl -i -X POST https://<staging-domain>/auth/v1/sign-in/email -H 'content-type: application/json' -d '{"email":"test@example.com","password":"x"}'
```

---

## 八、證據主檔案清單

- [src/lib/auth.ts](src/lib/auth.ts)
- [src/routes/auth.ts](src/routes/auth.ts)
- [src/middleware/rate-limit.ts](src/middleware/rate-limit.ts)
- [src/services/upload.ts](src/services/upload.ts)
- [src/routes/uploads.ts](src/routes/uploads.ts)
- [src/services/progress.ts](src/services/progress.ts)
- [src/routes/progress.ts](src/routes/progress.ts)
- [src/services/moderation.ts](src/services/moderation.ts)
- [src/index.ts](src/index.ts)
- [src/app.ts](src/app.ts)
- [wrangler.toml](wrangler.toml)
- [migrations/0001_init.sql](migrations/0001_init.sql)
- [migrations/0002_better_auth.sql](migrations/0002_better_auth.sql)
- [migrations/0003_user_uid_profile.sql](migrations/0003_user_uid_profile.sql)
- [migrations/0004_user_role_karma.sql](migrations/0004_user_role_karma.sql)
- [migrations/0005_auth_verifications_unique_identifier.sql](migrations/0005_auth_verifications_unique_identifier.sql)

---

結論：目前可進入「受控灰度前」階段，但不建議直接全量上線。請至少完成 P0 項目後，再進行正式發版。