# 拼圖聯盟 OS → Claude Code 接手包

交接日期：2026-10-23（Asia/Taipei）  
專案：`project-puzzle-union`／拼圖聯盟 OS  
工作目錄：`C:\Users\kuen\Documents\puzzle union`

## 1. Owner 本次授權與邊界

Owner 本次原意：「接下來我會使用 Claude Code 來協助完成這套系統。請你轉交授權、專案內容、專案進度。」隨後特別追問 GitHub 權限。Claude Code 可在 Owner 指派的後續任務中讀取此本機專案、現行指引與專案記憶，執行有明確範圍的本機調查、修改、測試和本機 Git 提交。每項功能或修復仍須先依 `AGENTS.md` 建立 exact-file Task Change Contract，保護既有功能與未提交工作，完成獨立審查及適用 Gate。

這份交接文件是 Owner 意圖與現況的來源紀錄，**不是 GitHub OAuth／PAT／SSH 權限或正式環境憑證**。沒有交付任何密碼、token 或秘密環境變數值。正式部署、正式 D1 寫入／遷移、對外訊息、費用及不可逆操作須依當次具體任務與平台權限處理。GitHub 遠端推送也須核對當次授權、實際登入身分與分支目標；不可因本文件而假定已能推送。

## 2. GitHub 存取實況（2026-10-23 本機觀察）

- 本機 Git remote：`origin = https://github.com/puzzleu2025-del/puzzle-alliance-os.git`；分支 `master`，HEAD `562ffe4813b11057374f75c52180f78ebd27607d`，追蹤 `origin/master`。本機 `git config --get credential.helper` 回傳 `manager`，但這只表示設定了 credential helper，**不證明憑證有效或具寫入權**。
- 此執行環境找不到 `gh` 和 `claude` 命令。`GIT_TERMINAL_PROMPT=0 git ls-remote origin HEAD` 因無法連上 `github.com:443` 失敗；因此今天沒有驗證 GitHub 登入、儲存庫讀取、推送權限或遠端是否仍與本機一致。不要把 2026-09-29 的推送成功視為今日權限證據。
- Claude Code 若在同一台 Windows 上執行，也須在**它自己的實際執行環境**確認網路、GitHub 身分及 repo 權限。先執行 `git remote -v`、`git status --short --branch`、`git ls-remote origin HEAD`；若安裝了 GitHub CLI，再用 `gh auth status` 與 `gh repo view puzzleu2025-del/puzzle-alliance-os --json viewerPermission`。需要寫入時再對明確分支做非破壞性的權限驗證。若環境無網路或未登入，請讓 Owner 在 Claude Code 所用環境完成 GitHub 認證／授權；不得要求把 PAT 或密碼貼進聊天或提交到 repo。
- GitHub 插件在 Codex 端目前未安裝；即使連上 Codex 的插件，也不會自動把權限轉給 Claude Code。沒有建立 GitHub 協作者邀請、修改 repository 權限或推送這份交接。

## 3. 產品與程式位置

拼圖聯盟 OS 是跨裝置的活動、任務、會議、行事曆、甘特圖、成員及活動報名協作系統。共用版以 React 19、Vinext/Vite、Cloudflare Worker、D1、Drizzle 運作；GitHub Pages 是入口／舊瀏覽器資料備份路徑，不能執行共用版 API 或 D1。

| 責任 | 現行來源 |
| --- | --- |
| 產品和執行方式 | `README.md`、`package.json` |
| 登入入口與工作空間 | `app/page.tsx`、`app/login-form.tsx`、`app/workspace.tsx` |
| Session／Auth／RBAC | `app/admin-auth.ts`、`app/api/auth/`、`app/api/members/` |
| 活動、任務、會議共用資料 | `app/api/workspace/route.ts`、`app/management-panels.tsx`、`app/calendar-panel.tsx` |
| 報名表與個資 | `app/api/registration-forms/route.ts`、`app/api/public/registrations/[slug]/route.ts`、`app/registration-*.tsx` |
| D1 與 schema | `db/`、`drizzle/` |
| ARGO 任務合約與回歸 | `AGENTS.md`、`docs/argo_governance.md`、`scripts/argo/`、`.argo/policy.json` |

目前 `app/page.tsx` 以 `getMember()` 分流登入表單與 Workspace；`app/api/workspace/route.ts` 以 session、CSRF、RBAC 及版本衝突檢查保護共用資料寫入。註冊與回覆個資另有獨立 API；不要以 UI 可見性代替後端授權檢查。初始管理員密碼只在正式站秘密環境變數 `INITIAL_ADMIN_PASSWORD`，不可寫進原始碼或交接紀錄。

## 4. 目前進度與未驗收事項

- **本機程式版本**：HEAD `562ffe4`（2026-09-29）。該版包含已結束項目收起／管理員歷史切換、手機月曆七欄、任務階段期限限制、報名表圖片與長文。當時的隔離 D1 一般回歸 41/41、功能回歸 85/85 及治理／建置檢查 PASS；這是歷史驗收，不是今天的功能或正式站驗收。
- **上次記錄的發布**：2026-09-29 GitHub `master` 的 Pages workflow 36455943496 成功；Sites 原專案第 9 版 deployment `appgdep_6aba9f33a0a081918f75abc665ec1890` 記錄為 succeeded。正式入口曾記錄為 `https://puzzle-alliance-os.gaoj3152.chatgpt.site`，Pages 入口為 `https://puzzleu2025-del.github.io/puzzle-alliance-os/`。今天未重新連線確認這兩個入口的狀態。
- **仍待真實驗收**：兩台真實裝置、不同角色／帳號的活動與任務共用寫入、成員核可、報名表個資範圍、總召／見習總召權限、提交後鎖定、個人行事曆。先前只有隔離本機 D1、跨 session 與正式管理員登入等局部證據；不得用歷史 PASS 代替真實裝置驗收。
- **後續候選工作**：評估舊瀏覽器 JSON 備份的受控匯入，以及活動提醒自動寄送。舊資料目前不會自動進入共用 D1；提醒內容可產生，但真正背景寄信尚需正式 Worker、排程與郵件供應商配置。候選工作不是已核准的實作範圍。
- **工作樹基準**：開始交接前 `master...origin/master`，已有未追蹤 `docs/argo_audit.md`；它屬既有工作，勿覆蓋、刪除、順手提交。本交接另新增本文件與 `.argo/contracts/puzzle-claude-handoff-20261023.json`；Claude Code 接手時須重新跑 `git status`，以當時實際狀態為準。

## 5. 必讀來源與接手順序

1. 在本 repo 讀 `AGENTS.md`、`README.md`、`docs/argo_governance.md`。專案規則是 **CHANGE ONLY WHAT IS REQUESTED**；Auth、共享導航、API、DB、環境、部署、依賴與治理檔預設保護，只有本次具體使用者要求才可在 contract 的 `protected_exceptions` 記錄授權。
2. 讀 `C:\Users\kuen\.codex\skills\personal-os\SKILL.md`，再以 `E:\個人營運記憶庫\工具\memory_start.py --vault E:\個人營運記憶庫 project-puzzle-union` 取最新狀態。交接時 state revision 26，更新於 2026-10-05，`stale=true`、`observed_at` 缺少；若 revision 已變，先以新狀態及原文校正本文件。Vault 無法讀取應明說，不可稱沒有記憶。
3. 依 `AGENTS.md` 每次新功能先 `node scripts/argo/run.mjs retrieve "功能"`；修改前 `begin`、exact-file `plan`、`execute`；修改後完整 `diff`、隔離 `regress`、不同實際 reviewer 的 `review`、PASS 後 `complete` 和 `gate`。身份字串不能充當獨立 agent 證據。細節見 `docs/argo_governance.md`。
4. 先核對 Git HEAD／未提交工作、目前程式及實際環境，再挑一件 Owner 指派的工作；不要以交接文件當新的功能需求。測試只能使用隔離本機 D1，禁止以正式 D1 做測試。需要遠端 GitHub、Sites 或正式資料動作時，先核對當次權限與事後讀回。

## 6. 來源與可信度

- 現行專案狀態：`E:\個人營運記憶庫\12-狀態\project-puzzle-union.md`（交接讀到 revision 26）；發布明細：`E:\個人營運記憶庫\14-詳細紀錄\project-puzzle-union\r000025-001.md`。
- 產品與工程現況：本 repo 的 `README.md`、`package.json`、上述 `app/` 與 `db/` 原始碼，及 `git status`、`git log`、`git remote -v`（2026-10-23 讀取）。
- 這是接手用的定點快照；正式站、GitHub 權限與真實裝置流程在交接時均未即時驗證。Claude Code 應自行建立當次證據，不能沿用歷史收據宣稱新的 PASS。
