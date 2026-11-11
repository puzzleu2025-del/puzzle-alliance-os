import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

test("isolated browser: own registrations states, pagination and identity switch", { timeout: 120000 }, async t => {
  const virtual = "virtual:my-page-test";
  const cacheDir = mkdtempSync(path.join(tmpdir(), "puzzle-my-vite-"));
  const server = await createServer({ configFile: false, cacheDir, root: process.cwd(), optimizeDeps: { noDiscovery: true, include: ["react", "react-dom/client", "react/jsx-dev-runtime"] }, plugins: [react(), {
    name: "my-page-test",
    resolveId(id) { if (id === virtual || id === "/" + virtual) return "\0" + virtual; },
    load(id) { if (id === "\0" + virtual) return `import React from 'react'; import {createRoot} from 'react-dom/client'; import My from '/app/participant/my/my-client.tsx'; createRoot(document.getElementById('root')).render(React.createElement(My));`; },
    configureServer(s) { s.middlewares.use(async (req, res, next) => { if (req.url === "/test") { res.setHeader("Content-Type", "text/html"); res.end(await s.transformIndexHtml(req.url, `<html><head></head><body><div id="root"></div><script type="module" src="/${virtual}"></script></body></html>`)); } else next(); }); },
  }], server: { host: "127.0.0.1", port: 0, strictPort: true } });
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  const pw = process.env.REGRESSION_PLAYWRIGHT || path.join(process.env.USERPROFILE || process.env.HOME, ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
  const { chromium } = await import(pathToFileURL(pw));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.REGRESSION_BROWSER ? { executablePath: process.env.REGRESSION_BROWSER } : process.platform === "win32" ? { channel: "chrome" } : {}) });
    async function setup(handler, mobile = false) {
      const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1440, height: 900 } });
      page.setDefaultTimeout(15000);
      page.on("pageerror", error => console.error("Browser error:", error.message));
      const calls = [];
      await page.route("**/api/participant/registrations/mine", async route => {
        const request = route.request();
        const item = { identity: request.headers()["x-participant-identity"], body: request.postDataJSON(), method: request.method() };
        calls.push(item);
        try { await handler(route, item, calls.length); } catch (error) { if (!/closed|aborted|handled/i.test(String(error))) throw error; }
      });
      await page.goto(base + "/test");
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
      assert.equal(await page.getByText(/QR/).count(), 0);
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
  } finally { if (browser) await browser.close(); await server.close(); rmSync(cacheDir, { recursive: true, force: true }); }
});
