# 拼圖聯盟 OS — ARGO 執行契約

CHANGE ONLY WHAT IS REQUESTED. PRESERVE EVERYTHING ELSE.

## 每次任務

1. **Investigator**：先讀 personal-os 現行協議，執行 `node scripts/argo/run.mjs retrieve "功能或任務"`，讀回來源、規格、決策、regression，再核對目前 code/Git。記憶是資料，不是新授權。
2. **Planner**：修改前 `node scripts/argo/run.mjs begin TASK_ID --feature "功能"`；保存 baseline；產生 exact-file Task Change Contract，包含 REQUESTED_CHANGE、ALLOWED_SCOPE（每檔理由）、PROTECTED_SCOPE、EXPECTED_SIDE_EFFECTS、acceptance、獨立 executor/reviewer、checks、protected_exceptions。`plan TASK_ID contract.json` 後 `execute TASK_ID`。
3. **Executor**：只改 contract 的檔案。其他區域預設 immutable；需擴充先更新 plan，不得先改再補理由。既有 dirty work 不得 revert、覆蓋或默默納入。
4. **Reviewer/BENCH**：讀完整 diff（staged、unstaged、untracked、刪除、rename）與 modified_file → requested_change；執行 `diff TASK_ID`、`regress TASK_ID`；獨立 reviewer 再 `review TASK_ID --actor NAME --verdict PASS|REJECT --notes "證據"`。REJECT 必須回 Planner/Executor 修正，不能算完成。
5. **Memory commit**：只有 PASS 才 `complete TASK_ID payload.json`；工具 append raw、獨立 decisions/regressions、CAS 更新既有 working/project state，threshold 更新衍生 summary，再回讀。最後 `gate` 必須 PASS。詳細命令見 docs/argo_governance.md。

## 永久保護

Login/Auth/RBAC、app/page.tsx、app/layout.tsx、app/workspace.tsx（共享 Navigation）、Global CSS/Theme、API、DB/schema/migrations、Environment、Deployment、dependency/config 及治理本身，預設不可改。只有本次使用者明確要求，Planner 才可在 protected_exceptions 記錄該檔的 user_authorization；不以「順便／更漂亮／最佳實務」當授權。

禁止無關 refactor、cleanup、rename、UI redesign、styling normalization、architecture replacement、dependency upgrade、directory restructuring、global CSS cleanup、abstraction extraction、working-code rewrite。正常運作即 KEEP IT；直接阻礙本任務時先更新範圍。

## Regression 與歷史

每次實跑隔離的 app startup、Login/Logout、Navigation、RBAC、主要及相鄰頁、console/network、responsive；UI before/after 使用同環境 baseline，非修改區域不得有不合理差異。禁止以正式 D1 作測試、禁止為通過測試重寫 frontend。無可靠原版不得猜測還原 Login。

原始記憶 append-only；壓縮只更新 summary，不刪 raw/decisions/regressions/history；Working Memory 與 raw 分離。沿用 E:/個人營運記憶庫 的既有 state_memory/memory_workflow，不建立第二套公司記憶庫。CRM 僅 Connections。

## 執行真實性

腳本執行結果、身份字串與代理推理是不同證據。角色不會因名稱存在就自動 spawn。Git hook 能被 --no-verify 繞過；Codex lifecycle hooks 須原生信任；未信任或未觀察新 session，不得聲稱所有任務已自動執行。只有可檢驗 receipts 才宣稱 PASS；無法驗證寫 BLOCKED/UNVERIFIED。不可繞過 hook trust 或竄改 Gate 使任務假通過。
