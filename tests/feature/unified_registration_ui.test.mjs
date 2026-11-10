import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const slug = "a".repeat(32);
const form = { id: "f1", activityId: "a1", title: "Test form", status: "open", privacyNotice: "Notice", fields: [{ id: "name", label: "Name", type: "short_text", required: true, profileKey: "displayName", sensitive: true }] };
const publicData = { form, activity: { name: "Activity" }, formVersion: 7 };

test("isolated browser: unified registration and legacy compatibility", { timeout: 120000 }, async (t) => {
  const virtual = "virtual:registration-test";
  const server = await createServer({ configFile: false, root: process.cwd(), optimizeDeps: { noDiscovery: true, include: ["react", "react-dom/client", "react/jsx-dev-runtime"] }, resolve: { alias: { "@": process.cwd() } }, plugins: [react(), {
    name: "registration-test",
    resolveId(id) { if (id === virtual || id === "/" + virtual) return "\0" + virtual; },
    load(id) { if (id === "\0" + virtual) return `import React from 'react'; import {createRoot} from 'react-dom/client'; import Unified from '/app/participant/register/registration-client.tsx'; import Legacy from '/app/r/[slug]/registration-client.tsx'; createRoot(document.getElementById('root')).render(location.pathname === '/legacy' ? React.createElement(Legacy,{slug:'${slug}'}) : React.createElement(Unified,{slug:'${slug}'}));`; },
    configureServer(s) { s.middlewares.use(async (req, res, next) => { if (req.url === "/test" || req.url === "/legacy") { res.setHeader("Content-Type", "text/html"); res.end(await s.transformIndexHtml(req.url, `<html><head></head><body><div id="root"></div><script type="module" src="/${virtual}"></script></body></html>`)); } else next(); }); },
  }], server: { host: "127.0.0.1", port: 0, strictPort: true } });
  await server.listen();
  const port = server.httpServer.address().port;
  const pw = process.env.REGRESSION_PLAYWRIGHT || path.join(process.env.USERPROFILE || process.env.HOME, ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
  const { chromium } = await import(pathToFileURL(pw));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.REGRESSION_BROWSER ? { executablePath: process.env.REGRESSION_BROWSER } : process.platform === "win32" ? { channel: "chrome" } : {}) });
    async function setup(options = {}) {
      const page = await browser.newPage({ viewport: { width: options.mobile ? 390 : 1440, height: 900 } });
      page.setDefaultTimeout(15000);
      page.on("pageerror", error => console.error("Browser error:", error.message));
      const calls = [];
      const records = new Map();
      await page.route("**/api/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        calls.push({ path: url.pathname, method: request.method(), headers: request.headers(), body: request.postDataJSON() });
        if (url.pathname.startsWith("/api/public/registrations/")) {
          return route.fulfill({ json: request.method() === "GET" ? publicData : { ok: true } });
        }
        if (url.pathname === "/api/participant/prefill") {
          if (options.delay) await new Promise(resolve => setTimeout(resolve, 350));
          return route.fulfill({ status: options.prefillStatus ?? 200, json: { formVersion: options.version ?? 7, values: { name: request.headers()["x-participant-identity"] === "member" ? "Member" : "Participant", injected: "secret" } } });
        }
        if (url.pathname === "/api/participant/registrations") {
          const count = calls.filter(c => c.path === url.pathname).length;
          const body = request.postDataJSON();
          if (options.conflict) return route.fulfill({ status: 409, json: { error: "conflict" } });
          if (options.rejectFirst && count === 1) return route.fulfill({ status: 400, json: { error: "invalid" } });
          if (records.size && !records.has(body.idempotencyKey)) return route.fulfill({ status: 409, json: { error: "conflict" } });
          if (!records.has(body.idempotencyKey)) records.set(body.idempotencyKey, { body, receiptId: "receipt" });
          else assert.deepEqual(body, records.get(body.idempotencyKey).body);
          if (options.serverErrorFirst && count === 1) return route.fulfill({ status: 503, json: { error: "unavailable" } });
          if (options.failFirst && count === 1) return route.abort("failed");
          return route.fulfill({ json: { receiptId: records.get(body.idempotencyKey).receiptId } });
        }
        return route.abort();
      });
      await page.goto(`http://127.0.0.1:${port}/${options.legacy ? "legacy" : "test"}`);
      return { page, calls, records };
    }
    await t.test("legacy anonymous form still posts to its original API", async () => {
      const { page, calls } = await setup({ legacy: true });
      await page.getByLabel("Name").fill("Legacy");
      await page.locator("#registration-privacy-consent").check();
      await page.getByRole("button", { name: "送出報名" }).click();
      await page.getByText("報名已送出").waitFor();
      const post = calls.find(c => c.method === "POST");
      assert.equal(post.path, `/api/public/registrations/${slug}`);
      assert.equal(post.body.answers.name, "Legacy");
      assert.equal(post.body.website, "");
      await page.close();
    });
    for (const [identity, label, name] of [["member", "會員", "Member"], ["participant", "參與者", "Participant"]]) {
      await t.test(`${identity} uses selected identity and waits for matching prefill`, async () => {
        const { page, calls } = await setup({ delay: true, mobile: identity === "participant" });
        await page.getByRole("button", { name: label, exact: true }).click();
        assert.equal(await page.getByLabel("Name").count(), 0);
        await page.getByLabel("Name").waitFor();
        assert.equal(await page.getByLabel("Name").inputValue(), name);
        await page.getByLabel("Name").fill("Edited");
        await page.locator("#registration-privacy-consent").check();
        await page.getByRole("button", { name: "送出報名" }).click();
        await page.getByText("報名已送出").waitFor();
        const post = calls.find(c => c.path === "/api/participant/registrations");
        assert.equal(post.headers["x-participant-identity"], identity);
        assert.equal(post.body.answers.name, "Edited");
        assert.equal(post.body.formVersion, 7);
        assert.equal(post.body.consent, true);
        assert.equal(calls.some(c => c.path === `/api/public/registrations/${slug}` && c.method === "POST"), false);
        assert.equal(await page.getByRole("button", { name: "送出報名" }).count(), 0);
        await page.close();
      });
    }
    for (const options of [{ version: 8 }, { prefillStatus: 503 }, { prefillStatus: 404 }]) {
      await t.test(`failed prefill blocks anonymous submission ${JSON.stringify(options)}`, async () => {
        const { page, calls } = await setup(options);
        await page.getByRole("button", { name: "會員", exact: true }).click();
        await page.getByRole("alert").waitFor();
        assert.equal(await page.locator("form").count(), 0);
        assert.equal(calls.some(c => c.method === "POST" && c.path !== "/api/participant/prefill"), false);
        await page.getByRole("button", { name: "返回選擇身分" }).click();
        await page.getByRole("button", { name: "參與者", exact: true }).click();
        await page.getByRole("alert").waitFor();
        assert.equal(calls.filter(c => c.path === "/api/participant/prefill").at(-1).headers["x-participant-identity"], "participant");
        await page.close();
      });
    }
    await t.test("committed response lost: original retry returns the same receipt without duplicate", async () => {
      const { page, calls, records } = await setup({ failFirst: true });
      await page.getByRole("button", { name: "會員", exact: true }).click();
      await page.getByLabel("Name").waitFor();
      await page.locator("#registration-privacy-consent").check();
      await page.getByRole("button", { name: "送出報名" }).click();
      await page.getByText("無法確認原報名結果，請保留此頁，勿重新整理或關閉；請重試原內容，若仍無法確認請聯絡活動工作人員。").waitFor();
      assert.equal(await page.getByLabel("Name").isDisabled(), true);
      assert.equal(records.size, 1);
      await page.getByRole("button", { name: "重試原報名內容" }).click();
      await page.getByText("報名已送出").waitFor();
      const posts = calls.filter(c => c.path === "/api/participant/registrations");
      assert.equal(posts.length, 2);
      assert.equal(posts[0].body.idempotencyKey, posts[1].body.idempotencyKey);
      assert.deepEqual(posts[0].body.answers, posts[1].body.answers);
      assert.equal(records.size, 1);
      assert.equal(records.get(posts[1].body.idempotencyKey).receiptId, "receipt");
      await page.close();
    });
    await t.test("server error retains original payload and key until confirmed", async () => {
      const { page, calls, records } = await setup({ serverErrorFirst: true });
      await page.getByRole("button", { name: "會員", exact: true }).click();
      await page.getByLabel("Name").waitFor();
      await page.locator("#registration-privacy-consent").check();
      await page.getByRole("button", { name: "送出報名" }).click();
      await page.getByText("無法確認原報名結果，請保留此頁，勿重新整理或關閉；請重試原內容，若仍無法確認請聯絡活動工作人員。").waitFor();
      assert.equal(await page.getByLabel("Name").isDisabled(), true);
      await page.getByRole("button", { name: "重試原報名內容" }).click();
      await page.getByText("報名已送出").waitFor();
      const posts = calls.filter(c => c.path === "/api/participant/registrations");
      assert.equal(posts.length, 2);
      assert.deepEqual(posts[0].body, posts[1].body);
      assert.equal(records.size, 1);
      await page.close();
    });
    await t.test("conflict directs the user to check with staff", async () => {
      const { page } = await setup({ conflict: true });
      await page.getByRole("button", { name: "會員", exact: true }).click();
      await page.getByLabel("Name").waitFor();
      await page.locator("#registration-privacy-consent").check();
      await page.getByRole("button", { name: "送出報名" }).click();
      await page.getByText("報名狀態或表單可能已變更，請聯絡活動工作人員確認是否已報名，再重新整理。").waitFor();
      assert.equal(await page.getByText("報名已送出").count(), 0);
      await page.close();
    });
    await t.test("definitive rejection allows changed answers and a fresh key", async () => {
      const { page, calls, records } = await setup({ rejectFirst: true });
      await page.getByRole("button", { name: "會員", exact: true }).click();
      await page.getByLabel("Name").waitFor();
      await page.locator("#registration-privacy-consent").check();
      await page.getByRole("button", { name: "送出報名" }).click();
      await page.getByText("目前無法送出，請檢查資料後再試。").waitFor();
      assert.equal(records.size, 0);
      await page.getByLabel("Name").fill("Different");
      await page.getByRole("button", { name: "送出報名" }).click();
      await page.getByText("報名已送出").waitFor();
      const posts = calls.filter(c => c.path === "/api/participant/registrations");
      assert.notEqual(posts[0].body.idempotencyKey, posts[1].body.idempotencyKey);
      assert.equal(records.size, 1);
      await page.close();
    });
  } finally { if (browser) await browser.close(); await server.close(); }
});
