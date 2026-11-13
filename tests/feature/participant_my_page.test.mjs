import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { createServer } from "node:http";
import react from "@vitejs/plugin-react";
import sharp from "sharp";
import decode from "../fixtures/jsqr.cjs";

test("isolated browser: own registrations states, pagination and identity switch", { timeout: 120000 }, async t => {
  const virtual = "virtual:my-page-test";
  const bundle = await build({ configFile: false, logLevel: "error", root: process.cwd(), build: { write: false, minify: false, rollupOptions: { input: virtual, output: { format: "iife" } } }, plugins: [react(), {
    name: "my-page-test",
    resolveId(id) { if (id === virtual || id === "/" + virtual) return "\0" + virtual; },
    load(id) { if (id === "\0" + virtual) return `import React from 'react'; import {createRoot} from 'react-dom/client'; import My from '/app/participant/my/my-client.tsx'; createRoot(document.getElementById('root')).render(React.createElement(My));`; },
  }] });
  const code = bundle.output.find(item => item.type === "chunk").code;
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", req.url === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
    res.end(req.url === "/app.js" ? code : '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const pw = process.env.REGRESSION_PLAYWRIGHT || path.join(process.env.USERPROFILE || process.env.HOME, ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
  const { chromium } = await import(pathToFileURL(pw));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.REGRESSION_BROWSER ? { executablePath: process.env.REGRESSION_BROWSER } : process.platform === "win32" ? { channel: "chrome" } : {}) });
    async function setup(handler, mobile = false) {
      const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1440, height: 900 } });
      page.setDefaultTimeout(15000);
      page.on("pageerror", error => console.error("Browser error:", error.message));
      page.on("console", message => { if (message.type() === "error") console.error("Browser console:", message.text()); });
      const calls = [];
      await page.route("**/api/participant/registrations/mine", async route => {
        const request = route.request();
        const item = { identity: request.headers()["x-participant-identity"], body: request.postDataJSON(), method: request.method() };
        calls.push(item);
        try { await handler(route, item, calls.length); } catch (error) { if (!/closed|aborted|handled/i.test(String(error))) throw error; }
      });
      await page.goto(base + "/test");
      await page.getByRole("heading", { name: "我的報名" }).waitFor().catch(async error => { console.error("Rendered page:", await page.locator("body").innerText()); throw error; });
      return { page, calls };
    }
    const entry = (id, title) => ({ submissionId: id, title, submittedAt: "2026-01-01T00:00:00.000Z" });
    await t.test("pagination sends cursor, appends only own data and supports mobile", async () => {
      const next = { submittedAt: "2026-01-01T00:00:00.000Z", submissionId: "a" };
      const { page, calls } = await setup((route, item) => route.fulfill({ json: item.body.cursor ? { registrations: [entry("b", "Second")], nextCursor: null } : { registrations: [entry("a", "First")], nextCursor: next } }), true);
      await page.getByRole("button", { name: "會員" }).click();
      await page.getByText("First", { exact: true }).waitFor();
      await page.getByRole("button", { name: "載入更多" }).click();
      await page.getByText("Second", { exact: true }).waitFor();
      assert.deepEqual(calls.map(c => [c.method, c.identity, c.body]), [["POST", "member", { cursor: null }], ["POST", "member", { cursor: next }]]);
      assert.equal(await page.getByRole("button", { name: "載入更多" }).count(), 0);
      assert.equal(await page.getByRole("img", { name: "個人簽到 QR 碼" }).count(), 0);
      await page.close();
    });
    await t.test("empty, temporary failure and retry", async () => {
      const { page } = await setup((route, item, n) => n === 1 ? route.fulfill({ status: 503, json: { error: "disabled" } }) : route.fulfill({ json: { registrations: [], nextCursor: null } }));
      await page.getByRole("button", { name: "參與者" }).click();
      await page.getByRole("alert").waitFor();
      await page.getByRole("button", { name: "重試" }).click();
      await page.getByText("目前沒有報名紀錄。").waitFor();
      await page.close();
    });
    await t.test("authorization loss clears earlier page", async () => {
      const { page } = await setup((route, item, n) => n === 1 ? route.fulfill({ json: { registrations: [entry("a", "Private")], nextCursor: { submittedAt: "2026", submissionId: "a" } } }) : route.fulfill({ status: 401, json: { error: "unauthorized" } }));
      await page.getByRole("button", { name: "會員" }).click();
      await page.getByText("Private").waitFor();
      await page.getByRole("button", { name: "載入更多" }).click();
      await page.getByText("登入已失效，請重新登入所選身分。").waitFor();
      assert.equal(await page.getByText("Private").count(), 0);
      await page.close();
    });
    await t.test("switch clears old records and ignores delayed response", async () => {
      let release;
      const waiting = new Promise(resolve => { release = resolve; });
      const { page, calls } = await setup(async (route, item) => {
        if (item.identity === "member" && item.body.cursor) { await waiting; return route.fulfill({ json: { registrations: [entry("old2", "Old delayed")], nextCursor: null } }); }
        return route.fulfill({ json: item.identity === "member" ? { registrations: [entry("old", "Old member")], nextCursor: { submittedAt: "2026", submissionId: "old" } } : { registrations: [entry("new", "New participant")], nextCursor: null } });
      });
      await page.getByRole("button", { name: "會員" }).click();
      await page.getByText("Old member").waitFor();
      await page.getByRole("button", { name: "載入更多" }).click();
      await page.getByRole("button", { name: "參與者" }).click();
      await page.getByText("New participant").waitFor();
      assert.equal(await page.getByText("Old member").count(), 0);
      release();
      await page.waitForTimeout(250);
      assert.equal(await page.getByText("Old delayed").count(), 0);
      assert.equal(calls.at(-1).identity, "participant");
      await page.close();
    });
    await t.test("withdrawal is explicit, participant-only, and clears the list on success", async () => {
      const { page } = await setup(route => route.fulfill({ json: { registrations: [entry("a", "Private")], nextCursor: null } }));
      let calls = 0;
      await page.route("**/api/participant/consent/withdraw", async route => {
        calls++;
        assert.equal(route.request().method(), "POST");
        assert.equal(route.request().postData(), null);
        await route.fulfill({ json: { ok: true } });
      });
      await page.getByRole("button", { name: "會員", exact: true }).click();
      await page.getByText("Private").waitFor();
      assert.equal(await page.getByRole("button", { name: "撤回加入名單同意" }).count(), 0);
      await page.getByRole("button", { name: "參與者", exact: true }).click();
      await page.getByText("Private").waitFor();
      await page.getByRole("button", { name: "撤回加入名單同意" }).click();
      assert.equal(calls, 0);
      await page.getByRole("button", { name: "確認撤回同意" }).click();
      await page.getByText(/已撤回同意/).waitFor();
      await page.getByText(/請重新登入並完成同意/).waitFor();
      assert.equal(calls, 1);
      assert.equal(await page.getByText("Private").count(), 0);
      await page.close();
    });
    await t.test("disabled withdrawal does not report success and can be retried", async () => {
      const { page } = await setup(route => route.fulfill({ json: { registrations: [], nextCursor: null } }));
      let calls = 0;
      await page.route("**/api/participant/consent/withdraw", route => {
        calls++;
        return route.fulfill({ status: calls === 1 ? 503 : 200, json: calls === 1 ? { error: "disabled" } : { ok: true } });
      });
      await page.getByRole("button", { name: "參與者", exact: true }).click();
      await page.getByRole("button", { name: "撤回加入名單同意" }).click();
      await page.getByRole("button", { name: "確認撤回同意" }).click();
      await page.getByText("目前無法撤回，請稍後再試。").waitFor();
      assert.equal(await page.getByText(/已撤回同意/).count(), 0);
      await page.getByRole("button", { name: "確認撤回同意" }).click();
      await page.getByText(/已撤回同意/).waitFor();
      assert.equal(calls, 2);
      await page.close();
    });
    await t.test("withdrawal with expired session clears personal records", async () => {
      const { page } = await setup(route => route.fulfill({ json: { registrations: [entry("a", "Private")], nextCursor: null } }));
      await page.route("**/api/participant/consent/withdraw", route => route.fulfill({ status: 401, json: { error: "expired" } }));
      await page.getByRole("button", { name: "參與者", exact: true }).click();
      await page.getByText("Private").waitFor();
      await page.getByRole("button", { name: "撤回加入名單同意" }).click();
      await page.getByRole("button", { name: "確認撤回同意" }).click();
      await page.getByText("登入已失效，請重新登入後再試。").waitFor();
      assert.equal(await page.getByText("Private").count(), 0);
      assert.equal(await page.getByText(/已撤回同意/).count(), 0);
      await page.close();
    });
    await t.test("QR issuance can recover after a failed request", async () => {
      const { page } = await setup(route => route.fulfill({ json: { registrations: [entry("a", "Activity")], nextCursor: null } }));
      let attempts = 0;
      await page.route('**/api/participant/qr', route => {
        attempts++;
        return attempts === 1 ? route.fulfill({ status: 503, json: { error: 'unavailable' } }) :
          route.fulfill({ json: { token: '0123456789abcdef'.repeat(4) } });
      });
      await page.getByRole('button', { name: '參與者', exact: true }).click();
      await page.getByText('Activity').waitFor();
      await page.getByRole('button', { name: '顯示 QR' }).click();
      await page.getByRole('alert').getByText('目前無法顯示 QR，請稍後重試或聯絡工作人員。').waitFor();
      await page.getByRole('button', { name: '重試顯示 QR' }).click();
      await page.getByRole('img', { name: '個人簽到 QR 碼' }).waitFor();
      assert.equal(attempts, 2);
      await page.close();
    });
    await t.test("own QR is rendered locally and its image decodes to the issued value", async () => {
      const token = '0123456789abcdef'.repeat(4);
      const { page } = await setup(route => route.fulfill({ json: { registrations: [entry("a", "Activity")], nextCursor: null } }));
      let issued = 0;
      await page.route('**/api/participant/qr', route => {
        issued++;
        assert.deepEqual(route.request().postDataJSON(), { submissionId: 'a' });
        assert.equal(route.request().headers()['x-participant-identity'], 'participant');
        return route.fulfill({ json: { token } });
      });
      await page.getByRole('button', { name: '參與者', exact: true }).click();
      await page.getByText('Activity').waitFor();
      await page.getByRole('button', { name: '顯示 QR' }).click();
      const image = page.getByRole('img', { name: '個人簽到 QR 碼' });
      await image.waitFor();
      const { data, info } = await sharp(await image.screenshot()).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.equal(decode(new Uint8ClampedArray(data), info.width, info.height)?.data, token);
      assert.equal((await page.locator('body').innerText()).includes(token), false);
      assert.equal(page.url().includes(token), false);
      assert.equal(issued, 1);
      await page.getByRole('button', { name: '會員', exact: true }).click();
      assert.equal(await image.count(), 0);
      await page.close();
    });
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
