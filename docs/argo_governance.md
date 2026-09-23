# ARGO 專案治理操作

本 repo 將既有 ARGO `argo_task.py` 原封保留為 `scripts/argo/ledger.py`（SHA256 `765D2D089351FD816C76FF0411A9782064CAC767418FF82CF071ECDF622CC382`）。`govern.py` 為 repo adapter，增加完整 diff、測試 receipt 與記憶 gate，不更換應用架構。

## 真正能阻擋的範圍

- `plan` 缺少 exact-file allowlist、理由、獨立 reviewer、必要 checks、保護區授權時退出非零。
- `execute` 要求成功 retrieval 與 baseline；`diff` 比較任務起點的工作檔與 index，包括新增、刪除、rename 兩端及 ignored 環境／hook 控制檔。既有 dirty work 不可採納覆寫。
- `regress` 以 argv 執行真實命令，保存 exit code、log hash、source fingerprint；失敗回 REJECTED。
- `review PASS` 要求 fresh regression、完整 diff PASS 與不同 actor。actor 是可審計身份標籤，不是密碼認證；不能把更換字串當獨立審查。
- `complete` 要求 reviewer PASS 且 source 未變；append raw、decisions、regressions；调用既有 state_memory.py CAS 更新 project/working state，讀回後才 COMPLETE。部分記憶失敗停 MEMORY_PENDING 可重試。
- `gate` 要求 COMPLETE、source/暫存內容與證據一致、raw hash 未變。Git pre-commit 執行它；失敗阻擋普通 commit，`--no-verify` 可繞過，因此不是伺服器強制政策。
- 根 AGENTS.md 是新 repository session 的規則入口；`.codex/hooks.json` 是 SessionStart/UserPromptSubmit retrieval 與 Stop completion gate。**須由使用者在 Codex 原生 `/hooks` 檢閱並信任後才自動執行**；此實作不竄改信任或啟用 bypass。這不會自動產生四個 LLM agents，也不能從 OS 層禁止任意檔案寫入。
- 尚未安裝 server required checks/branch protection，既有 deployment workflow 不變。不要聲稱自動部署 Gate 已完成。

## 任務命令

從 repo 根目錄執行；需要 Git、Python 3、Node。`ARGO_PYTHON` 可指定已安裝 Python，`ARGO_VAULT` 可選測試 vault（不可選 CRM）。

```text
node scripts/argo/run.mjs retrieve "活動管理"
node scripts/argo/run.mjs begin task-id --feature "活動管理"
node scripts/argo/run.mjs plan task-id work/contract.json
node scripts/argo/run.mjs execute task-id
# 僅修改合約內的檔案
node scripts/argo/run.mjs diff task-id
node scripts/argo/run.mjs regress task-id
node scripts/argo/run.mjs review task-id --actor independent-reviewer --verdict PASS --notes "實際審查與證據路徑"
node scripts/argo/run.mjs complete task-id work/memory.json
node scripts/argo/run.mjs gate
```

REJECT 後先修復本任務越界 diff（不得回復使用者既有工作），重新 `plan` → `execute` → `regress` → `review`。本機 runtime 是 `.argo/runtime/`，不提交；contract revision 與 baseline 保留。已完成任務的下一輪以新 ID `begin`；開始前先妥善提交／交接上輪變更，未提交檔案在新任務會被視為 preexisting dirty、不可覆蓋。

Contract 完整範例見 `.argo/contracts/argo-governance-20260923.json`。`ALLOWED_SCOPE` 是檔案到使用者需求理由的 mapping；不可用 `*`；必要 checks 是 governance 與 application_regression。新增功能仍需合約指定該功能與鄰近頁的額外驗收，不可只跑通用 smoke。

## 測試與畫面基準

```text
python -m unittest discover -s tests/argo -p test_govern.py -v
node scripts/run-framework.mjs build
node scripts/argo/regression.mjs --repo=. --out=.argo/runtime/before
# 在相同瀏覽器/locale/viewport 與固定 fixture 下比較
node scripts/argo/regression.mjs --repo=. --out=.argo/runtime/after --compare=.argo/runtime/before
```

Runner 使用既有 bundled Playwright，沒有新增 dependency/framework。`REGRESSION_PLAYWRIGHT` 與 `REGRESSION_BROWSER` 可指向其他現有安裝；缺少時失敗不假通過。先 build，才可測目前 source；本次合約把 build 放在 application regression 之前。Runner 只接受 loopback port，複製 dist 到全新目錄，套用 migrations 到全新 local D1、最後關閉自身 server；不碰現有 D1 或正式資料。

報告含 login/logout、錯誤登入、admin/member/coordinator RBAC、10 個管理導覽、主要畫面、console/network、手機 overflow、screenshots 與精確 before/after hash/text。故意觸發的拒絕狀態只在 API assertion 中接受；瀏覽器意外錯誤一律失敗。每次 baseline 是固定 fixture 的現況，不代表完整產品規格正確，也不證明正式雙裝置／真實個資流程。

## 單一第二大腦映射

|需求層|現有 vault 的實際位置|
|---|---|
|00_raw|14-詳細紀錄/project-puzzle-union/argo-raw/*.json|
|01_projects|07-專案；目前專案 canonical state 用 12-狀態/project-puzzle-union.md|
|02_decisions|03-決策/project-puzzle-union/*.json|
|03_specs|08-對話/conversation-puzzle-union-auth-profile-20260923.md 及 README/原始需求|
|04_working_memory|12-狀態/project-puzzle-union.md，既有 state_memory.py 管理；13-紀錄保留歷史|
|05_summary|05-摘要/project-puzzle-union/current.json（衍生資料）|
|06_regressions|04-知識/回歸紀錄/project-puzzle-union/*.json|

Raw 每任務一檔、exclusive create，相同內容可重試，異內容拒絕；壓縮不刪或覆寫 raw。這是工具層 append-only，不是磁碟 ACL 防篡改。Summary 保存來源 SHA256，初次建立後累積 5 個新增/變更來源才更新，保留最近 30 則可回溯摘錄。未達門檻仍在 retrieval 讀獨立 decisions/regressions 與目前 state，不靠 summary 作唯一真相。沒有背景全聊天匯入。

`complete` payload 必備：task、user_request、relevant_context、decisions、rejected_approaches、discovered_constraints、bugs、regressions、tests_performed、user_correction、final_outcome、state、expected_revision。state 使用既有 state_memory.py put schema，保持當下 state 欄位與歷史 detail_refs，不能以本次治理結案把整個協會專案標記 completed。Decisions 各含 Decision/Context/Reason/Alternatives/Consequences/Date/Related files/features；Regressions 各含 event/Cause/Prevention/Required regression checks。禁止把密碼或完整工具紀錄寫入記憶。

## 啟用與待驗證項

先核對沒有既有自訂 hooks，再 `git config --local core.hooksPath .githooks`。只影響此 checkout；新 clone 需再次設定。Hooks 內容審閱入口：`codex` → `/hooks`。搬移 repo/Python 後更新 `.codex/hooks.json` 的 absolute command 並重新信任。AGENTS 載入依 Codex 的 repo/cwd 規則，於此 repo 開新 session 才能查驗；projectless chat 不保證讀到別處 repo 指引。

官方依據：https://learn.chatgpt.com/docs/agent-configuration/agents-md 、https://learn.chatgpt.com/docs/hooks 。安裝檔、manual hook invocation 與新 session 真實自動觸發必須在最終報告分開。
