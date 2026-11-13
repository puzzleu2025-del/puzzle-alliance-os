import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

test("consent return link is fixed, validated and only shown on success", { timeout: 120000 }, async t => {
  const virtual = "virtual:consent-return-test";
  const cacheDir = mkdtempSync(path.join(tmpdir(), "puzzle-consent-vite-"));
  const server = await createServer({ configFile: false, cacheDir, root: process.cwd(), optimizeDeps: { noDiscovery: true, include: ["react", "react-dom/client", "react/jsx-dev-runtime"] }, plugins: [react(), {
    name: "consent-return-test",
    resolveId(id) { if (id === virtual || id === "/" + virtual) return "\0" + virtual; },
    load(id) { if (id === "\0" + virtual) return `import React from 'react'; import {createRoot} from 'react-dom/client'; import Page from '/app/participant/consent/page.tsx'; const params={}; for (const [k,v] of new URLSearchParams(location.search)) params[k] = k in params ? (Array.isArray(params[k]) ? [...params[k],v] : [params[k],v]) : v; createRoot(document.getElementById('root')).render(await Page({searchParams:Promise.resolve(params)}));`; },
    configureServer(s) { s.middlewares.use(async (req, res, next) => { if (req.url?.split("?")[0] === "/test") { res.setHeader("Content-Type", "text/html"); res.end(await s.transformIndexHtml(req.url, `<html><head></head><body><div id="root"></div><script type="module" src="/${virtual}"></script></body></html>`)); } else next(); }); },
  }], server: { host: "127.0.0.1", port: 18000 + Math.floor(Math.random() * 40000), strictPort: false } });
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  const pw = process.env.REGRESSION_PLAYWRIGHT || path.join(process.env.USERPROFILE || process.env.HOME, ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
  const { chromium } = await import(pathToFileURL(pw));
  const slug = "a".repeat(32);
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.REGRESSION_BROWSER ? { executablePath: process.env.REGRESSION_BROWSER } : process.platform === "win32" ? { channel: "chrome" } : {}) });
    async function setup(query, status = 200) {
      const page = await browser.newPage({ viewport: { width: 390, height: 850 } });
      page.setDefaultTimeout(30000);
      page.on("pageerror", error => console.error("Browser error:", error.message));
      page.on("console", message => { if (message.type() === "error") console.error("Browser console:", message.text()); });
      const posts = [];
      await page.route("**/api/participant/consent", route => {
        if (route.request().method() === "GET") return route.fulfill({ json: { version: "v1", content: "Terms" } });
        posts.push(route.request().postDataJSON());
        return route.fulfill({ status, json: status === 200 ? { ok: true } : { error: "failed" } });
      });
      await page.goto(base + "/test" + query, { waitUntil: "domcontentloaded", timeout: 30000 });
      return { page, posts };
    }
    for (const [name, query, valid] of [
      ["valid", `?slug=${slug}`, true], ["missing", "", false],
      ["repeated", `?slug=${slug}&slug=${slug}`, false], ["extra destination", `?slug=${slug}&next=https://evil.example`, false],
      ["external", "?slug=https%3A%2F%2Fevil.example", false], ["uppercase", `?slug=${slug.toUpperCase()}`, false],
    ]) await t.test(name, async () => {
      const { page, posts } = await setup(query);
      await page.getByText("Terms", { exact: true }).waitFor();
      assert.equal(await page.getByRole("link", { name: "返回報名" }).count(), 0);
      await page.getByRole("checkbox").check();
      await page.getByRole("button", { name: "確認同意" }).click();
      await page.getByText("已完成同意。").waitFor();
      assert.deepEqual(posts, [{ version: "v1", checked: true }]);
      const link = page.getByRole("link", { name: "返回報名" });
      assert.equal(await link.count(), valid ? 1 : 0);
      if (valid) assert.equal(await link.getAttribute("href"), `/participant/register?slug=${slug}`);
      else assert.equal(await page.getByRole("link", { name: "查看我的報名與 QR" }).getAttribute("href"), "/participant/my");
      await page.close();
    });
    await t.test("failure never exposes completion or return", async () => {
      const { page } = await setup(`?slug=${slug}`, 409);
      await page.getByText("Terms", { exact: true }).waitFor();
      await page.getByRole("checkbox").check();
      await page.getByRole("button", { name: "確認同意" }).click();
      await page.getByText("無法完成同意，內容可能已更新。請重新登入後再試。").waitFor();
      assert.equal(await page.getByRole("link", { name: "返回報名" }).count(), 0);
      assert.equal(await page.getByText("已完成同意。").count(), 0);
      await page.close();
    });
  } finally { if (browser) await browser.close(); await server.close(); rmSync(cacheDir, { recursive: true, force: true }); }
});
