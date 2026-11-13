# 會議資料切換與回滾：待演練草案

此草案尚未在隔離 D1 演練，不是正式切換指令。正式切換及回滾前，必須先完成隔離 D1、舊版實際讀寫與備份還原演練，並經獨立審查。禁止在正式 D1 上測試。

## 切換至新版

停止新舊版所有 workspace 寫入並等待執行中的請求完成；取得且驗證可還原的備份。執行 migration 後，比對舊 JSON 與會議表每筆內容、順序及數量，確認無誤才切換新版並恢復寫入。切換窗口不可允許舊版繼續寫入，否則複製後的修改不會進入會議表。

## 回切舊版

新版成功寫入後，workspace JSON 的 meetings 會是空陣列；直接切回舊版會看不到會議。先停止新舊版所有寫入、等待請求排空，取得並驗證備份。須在單一交易或具原子性的 D1 batch 中，按 position 將會議表內容回填 workspace JSON 的 meetings，保留其他欄位並遞增 version，使舊快照失效。若 workspace 列不存在而會議表有資料，立即停止並調查，不可自行建立或丟棄資料。

本機 SQLite 測試中的核心更新語句如下；它不是已驗證可直接用於正式 D1 的操作流程：

```sql
UPDATE workspace_states
SET data = json_set(data, '$.meetings', json((SELECT json_group_array(json(data)) FROM (SELECT data FROM meetings ORDER BY position)))),
    version = version + 1
WHERE id = 1;
```

在仍凍結寫入的狀態下，逐筆核對回填前會議表與回填後 JSON 的內容、順序和數量，核對其他欄位未變、version 已遞增。舊版 GET/PUT 實寫驗證僅在隔離環境演練；正式環境不進行測試寫入。正式回切及恢復寫入前須另有經授權的切換與驗證方案。保留會議表及備份。舊版再次寫入後會議表不會同步，重新切換新版前必須另行制定並演練同步程序，不可直接切回。
