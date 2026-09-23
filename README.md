# Puzzle Alliance OS

跨裝置的活動、任務、會議、行事曆與甘特圖協作平台。共用版使用 Vinext、Cloudflare D1 與 Drizzle；GitHub 儲存庫保存原始碼，GitHub Pages 將訪客導向共用版。

## GitHub Pages

推送到 `master` 後，`.github/workflows/pages-preview.yml` 會建立並發布入口頁。儲存庫第一次啟用時，請在 GitHub 的 **Settings → Pages → Build and deployment** 選擇 **GitHub Actions**。

GitHub Pages 無法執行伺服器端 API 或 D1。真正會儲存與同步的服務位於 [共用工作空間](https://puzzle-alliance-os.gaoj3152.chatgpt.site/)；Pages 入口會將沒有舊資料的訪客導向該站。若目前瀏覽器保有舊版資料，入口先提供 JSON 備份與舊版檢視；舊資料不會自動移入共用資料庫。

共用版只使用本站帳號密碼登入。初始系統管理員為「嘉駿」，首次登入後請在「系統設定」更改密碼；初始密碼放在正式站的秘密環境變數 `INITIAL_ADMIN_PASSWORD`，不寫進 GitHub 原始碼。新成員註冊時填姓名、聯絡電話及可選的 Email、單位與職務，由管理員核可；所有已核可成員可在「系統設定」修改自己的資料與密碼。報名個資由獨立 API 管理，僅管理員及總召可檢視。

## 活動報名中心

- 每場活動有獨立的主要報名表，可使用短答、段落、電子郵件、電話、數字、日期、單選、下拉、複選與同意勾選題。
- 公開連結只提供表單與送出功能，不公開其他人的填答；管理名單、顯示個資、對帳註記及 Excel 匯出需管理員權限。
- 對帳可標示未對帳、待確認、已對帳、已退款或無需付款，並保存備註；Excel 會一併輸出對帳與提醒欄位。
- 系統依活動日期計算前 5 天與前 1 天的提醒日期，並可產生每位參加者的郵件內容。真正的自動寄信仍需正式 Worker、排程觸發器與郵件供應商密鑰；GitHub Pages 預覽不會在背景寄信。
- 舊版 Pages 預覽只把報名表、測試填答與對帳狀態保存在原瀏覽器；共用版使用 D1 的 `registration_forms` 與 `registration_submissions` 資料表，需使用新版 `/r/{slug}` 報名連結。

## Prerequisites

- Node.js `>=22.13.0`
- Portable: Windows, macOS, or Linux; no Bash required
- Managed Linux: managed Linux runtime with Bash, `flock`, `curl`, `sha256sum`, and GNU `timeout`
- Git is required only for publishing

## Sites Lifecycle

The Sites initializer copies the shared starter and selects managed-linux only when `SITES_MANAGED_LINUX_CONTAINER=1`; otherwise it selects portable. It saves the selection only in ignored `.sites-runtime/execution-profile.json`. Both profiles copy/configure first, then use the plugin's separate `install-dependencies.mjs` step to measure installation independently. Edit source under `app/` and follow the Sites skill for installation, preview, builds, and publishing.

Whenever reopening or moving a checkout, run `node <plugin-root>/scripts/configure-execution-profile.mjs` before project commands. Profile changes do not alter tracked source or require reinstalling otherwise-valid dependencies; restart an existing preview to use the new selection. Do not commit or upload `.sites-runtime/`.

This starter does not use `wrangler.jsonc`.

`install:ci` runs `npm ci` once against the shared lockfile, disables parent-workspace discovery, and includes required dev/optional dependencies despite production/omit settings. Sharp defaults to prebuilt binaries unless explicitly configured otherwise. Do not overlap installers.

- **Portable:** Preserve host HOME, npm cache, registry, proxy, temporary paths, retry/concurrency settings, and lifecycle-script policy. Use `--prefer-offline --no-audit --no-fund`.
- **Managed Linux:** Use the existing project-local HOME/cache/tmp setup and Linux install lock, tarball preflight, and timeout. Restore the image-seeded npm cache only when its lockfile hash matches; retain network fallback. Builds keep their existing timeout. These helpers are not invoked by the portable profile.

`scripts/sites-env.mjs` preserves the caller's HOME, npm cache, proxy, XDG, and temporary-directory configuration while defaulting Wrangler and Miniflare state to the checkout. If npm reports an unwritable cache, select a writable path with `npm_config_cache` for that install. The `dev` and `start` scripts also keep Wrangler logs inside the checkout. Generated `.sites-runtime/` and `.wrangler/` directories are disposable and ignored by Git.

On portable, `npm run dev` uses `vinext dev` with HMR, starting at port 5173. Vinext records the running server in ignored `.vinext/` state, rejects an ordinary duplicate launch, and recovers stale state after a stopped process; exactly simultaneous starts can race. Pass `--port <port>` or `--hostname <host>` after `npm run dev --` when needed; keep portable previews on loopback.

For browser QA on managed Linux, use `sites-preview start`. The project's dev script runs Vite and accepts the supervisor's `--host 0.0.0.0 --port 4173 --strictPort` arguments. The internal browser uses `http://terminal.local:4173/`; it is not a user-facing URL. The supervisor owns the preview lifecycle. The ignored local profile survives the supervisor's cleared process environment.

The workspace uses its own username/password session and D1 membership records.

The Worker uses `vinext/server/fetch-handler`, including Vinext's config-aware image handling. After building, `npm start` runs that Worker locally through Wrangler on `127.0.0.1`, sharing `.wrangler/state` with dev preview and local D1 migrations; it does not deploy the site or simulate sign-in. Use the URL printed by the server. Pass `npm start -- --port <port>` to select a different built-preview port.

Local previews use Miniflare's placeholder `Request.cf` metadata without a network lookup. Set `CLOUDFLARE_CF_FETCH_ENABLED=true` to opt into fetching preview metadata; this setting does not change hosted request metadata.

Local tool usage metrics are disabled by default. Set `WRANGLER_SEND_METRICS=true` to opt in.

## Included Shape

- edit site code under `app/`
- `app/admin-auth.ts` manages the workspace's own account sessions
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/index.ts` reads the D1 binding from the Cloudflare Worker environment
- `db/schema.ts` defines the shared D1 tables
- `@cloudflare/workers-types` provides Worker types; `cloudflare-env.d.ts` declares optional `DB`/`BUCKET` bindings—update these declarations if binding names change
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Local D1 migrations

For a D1-backed local preview, generate SQL with `npm run db:generate`. Build once through the Sites skill's build entrypoint (or `npm run build` for standalone use) to generate `dist/server/wrangler.json`, rebuilding if bindings change. From the project root, apply each pending migration in order:

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_example.sql
```

Replace the filename with the pending migration and `DB` with your D1 binding name if different. Use `.wrangler/state`, not `.wrangler/state/v3`; Wrangler adds the versioned directories. Do not replay migrations already applied locally. This updates only the preview database; publishing applies production migrations separately.

## Diagnostic Commands

- `npm run install:ci`: perform the one locked dependency install
- `npm run dev`: start the Vite/Vinext development server
- `npm run build`: build the deployable Sites artifact
- `npm run start`: preview the built Worker locally with D1/R2 support
- `npm run db:generate`: generate Drizzle migrations after schema changes

When using the Sites plugin, follow its skill instructions for installation, builds, and publishing. These npm commands remain available for standalone use.

The portable build runs Vinext directly without a host `timeout` command. The managed-linux build uses `scripts/build-verified.sh` and its existing `SITES_BUILD_TIMEOUT` setting.

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
