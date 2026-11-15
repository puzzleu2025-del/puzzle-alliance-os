# 參與者 Google 登入：部署設定

本文件只列設定名稱與步驟，不含任何密鑰值。密鑰只能放在部署環境的秘密設定中，不得寫入 repo、記憶庫或對話。

## 程式端已接上的部分

- 入口：`/participant` 送出 `POST /api/participant/auth/start`，回呼為 `GET /api/participant/auth/callback`。
- 驗證：PKCE（S256）、一次性交易、綁定 cookie、固定 Google token 與 JWKS 端點、ID token 簽章、issuer、audience、nonce、email_verified 逐項檢查。
- 結果：只建立待確認身分；同意條款後才建立參與者 session。
- 本機測試：`tests/feature/participant_oauth*.test.mjs`、`participant_service_routes.test.mjs` 以模擬的 Google 回應驗證上述流程（113 項通過）。

## 部署時需設定的環境變數

| 名稱 | 內容 | 規則 |
| --- | --- | --- |
| `PARTICIPANT_ENABLED` | `true` 才啟用 | 其他值一律停用，回 503 |
| `PARTICIPANT_ORIGIN` | 站台網址，例如 `https://<測試站網域>` | 必須是 https、無路徑、無帳密 |
| `PARTICIPANT_GOOGLE_CLIENT_ID` | Google OAuth 用戶端 ID | 格式 `數字-字串.apps.googleusercontent.com` |
| `PARTICIPANT_GOOGLE_CLIENT_SECRET` | Google OAuth 用戶端密鑰 | 秘密設定，不進 repo |
| `PARTICIPANT_TERMS_VERSION` | 目前生效的條款版本號 | 須與已發布條款一致 |
| `PARTICIPANT_TRUST_CLOUDFLARE_EDGE` | 僅在確認來源為 Cloudflare 邊緣時設 `true` | 預設不信任 |

Google 用戶端的已授權重新導向 URI 必須設為：

`<PARTICIPANT_ORIGIN>/api/participant/auth/callback`

## 上線前順序

1. 在測試站以系統管理員發布條款：`POST /api/participant/terms`（只能初次發布一次，版本號即 `PARTICIPANT_TERMS_VERSION`）。條款內容須先由使用者定稿，目前草稿尚未定稿。
2. 在秘密設定中填入上表變數，最後才設 `PARTICIPANT_ENABLED=true`。
3. 以測試帳號完成：登入、同意、報名、「我的報名」、QR 簽發與撤回。使用測試資料，不使用正式資料。

## 目前狀態

- 尚未在測試站設定上述變數，因此服務仍為停用（預設行為）。
- 尚未以真實 Google 帳號完成登入驗收；需待部署授權後執行。
- 兩台真實裝置驗收尚未進行。
