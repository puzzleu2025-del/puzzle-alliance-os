import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

globalThis.__termsTestEnv = {};
globalThis.__termsTestHeaders = new Headers();
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const env=globalThis.__termsTestEnv", shortCircuit: true };
  if (specifier === "next/headers") return { url: "data:text/javascript,export async function headers(){return globalThis.__termsTestHeaders}", shortCircuit: true };
  if (specifier === "@/app/admin-auth") return { url: pathToFileURL(path.resolve("app/admin-auth.ts")).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { POST } = await import("../../app/api/participant/terms/route.ts");
const env = globalThis.__termsTestEnv;
const origin = "https://puzzle.example";
const adminToken = "a".repeat(64), memberToken = "b".repeat(64);
const hash = token => createHash("sha256").update(token).digest("hex");

function fixture({ barrier = false } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync("drizzle").filter(n => /^[0-9]{4}_.*\.sql$/.test(n)).sort()) sqlite.exec(readFileSync("drizzle/" + file, "utf8"));
  const insertMember = sqlite.prepare("INSERT INTO members (user_id,username,email,display_name,role,status,created_at) VALUES (?,?,?,?,?,?,?)");
  insertMember.run("member1", "member1", "b@example.test", "Member", "member", "active", "2026");
  const insertSession = sqlite.prepare("INSERT INTO admin_sessions (token_hash,user_id,expires_at) VALUES (?,?,?)");
  insertSession.run(hash(adminToken), "admin-kao19950411", Date.now()+60_000);
  insertSession.run(hash(memberToken), "member1", Date.now()+60_000);
  let waiting = 0, release;
  const both = new Promise(resolve => { release = resolve; });
  function statement(sql, values = []) {
    return { sql, values, bind(...v) { return statement(sql,v); },
      async first() { const row=sqlite.prepare(sql).get(...values); return row ? { ...row } : null; },
      async run() { const result=sqlite.prepare(sql).run(...values); return { success:true, meta:{changes:Number(result.changes)} }; } };
  }
  const db = { prepare: sql => statement(sql), async batch(statements) {
    if (barrier) { if (++waiting === 2) release(); await both; }
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map(({sql,values}) => ({success:true,meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}}));
      sqlite.exec("COMMIT"); return results;
    } catch (e) { sqlite.exec("ROLLBACK"); throw e; }
  } };
  env.DB = db;
  return { sqlite, db, close() { delete env.DB; sqlite.close(); } };
}
function request(value = {version:"test-v1",content:"僅供測試，請勿填寫真實資料。"}, options = {}) {
  const headers = { Origin:origin, "Content-Type":"application/json", ...options.headers };
  globalThis.__termsTestHeaders = new Headers({cookie:options.cookie ?? `puzzle_admin_session=${adminToken}`});
  return new Request(options.url ?? origin+"/api/participant/terms", { method:"POST", headers,
    body:options.raw !== undefined ? options.raw : JSON.stringify(value), ...(options.duplex ? {duplex:"half"} : {}) });
}
function counts(sqlite) {
  return ["participant_terms","participant_terms_current"].map(table => sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
}

test("only same-origin active system administrator can initialize", async () => {
  const f=fixture();
  try {
    assert.equal((await POST(request(undefined,{headers:{Origin:"https://elsewhere.example"}}))).status,403);
    assert.equal((await POST(request(undefined,{cookie:""}))).status,403);
    assert.equal((await POST(request(undefined,{cookie:`puzzle_admin_session=${memberToken}`}))).status,403);
    assert.deepEqual(counts(f.sqlite),[0,0]);
    const response=await POST(request());
    assert.equal(response.status,201);
    assert.equal(response.headers.get("cache-control"),"no-store");
    assert.deepEqual(await response.json(),{ok:true,version:"test-v1"});
    assert.deepEqual(counts(f.sqlite),[1,1]);
    assert.deepEqual({...f.sqlite.prepare("SELECT t.version,t.content FROM participant_terms_current c JOIN participant_terms t ON t.version=c.version").get()}, {version:"test-v1",content:"僅供測試，請勿填寫真實資料。"});
  } finally { f.close(); }
});

test("invalid bodies and bounded streams fail without writes", async () => {
  const f=fixture();
  try {
    for (const value of [null, [], {}, {version:"",content:"x"}, {version:"bad version",content:"x"},
      {version:"a".repeat(81),content:"x"}, {version:"v1",content:" "}, {version:"v1",content:"x".repeat(10001)},
      {version:"v1",content:"x\u0000"}, {version:"v1",content:"x",extra:true}]) {
      assert.equal((await POST(request(value))).status,400);
    }
    assert.equal((await POST(request(undefined,{headers:{"Content-Type":"text/plain"}}))).status,400);
    const bytes=new TextEncoder().encode("x".repeat(16_385));
    const stream=new ReadableStream({start(c){ c.enqueue(bytes); c.close(); }});
    assert.equal((await POST(request(undefined,{raw:stream,duplex:true,headers:{"Content-Length":"1"}}))).status,400);
    assert.deepEqual(counts(f.sqlite),[0,0]);
  } finally { f.close(); }
});

test("existing terms cannot be replaced or leave a new orphan", async () => {
  const f=fixture();
  try {
    assert.equal((await POST(request())).status,201);
    assert.equal((await POST(request())).status,409);
    assert.equal((await POST(request({version:"test-v2",content:"new"}))).status,409);
    assert.deepEqual(counts(f.sqlite),[1,1]);
    assert.equal(f.sqlite.prepare("SELECT version FROM participant_terms_current").get().version,"test-v1");
  } finally { f.close(); }
});

test("concurrent first requests produce exactly one current version and no orphan", async () => {
  const f=fixture({barrier:true});
  try {
    const req1=request({version:"v1",content:"one"});
    const req2=request({version:"v2",content:"two"});
    const results=await Promise.all([POST(req1),POST(req2)]);
    assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
    assert.deepEqual(counts(f.sqlite),[1,1]);
    const row=f.sqlite.prepare("SELECT t.version,t.content FROM participant_terms t JOIN participant_terms_current c ON c.version=t.version").get();
    assert.ok((row.version==="v1" && row.content==="one") || (row.version==="v2" && row.content==="two"));
  } finally { f.close(); }
});

test("batch failure rolls back terms; inactive or expired admin cannot publish", async () => {
  const f=fixture();
  try {
    f.sqlite.exec("CREATE TRIGGER terms_test_fail BEFORE INSERT ON participant_terms_current BEGIN SELECT RAISE(ABORT,'test'); END");
    assert.equal((await POST(request())).status,503);
    assert.deepEqual(counts(f.sqlite),[0,0]);
    f.sqlite.exec("DROP TRIGGER terms_test_fail; UPDATE members SET status='inactive' WHERE user_id='admin-kao19950411'");
    assert.equal((await POST(request())).status,403);
    f.sqlite.exec("UPDATE members SET status='active' WHERE user_id='admin-kao19950411'; UPDATE admin_sessions SET expires_at=0 WHERE user_id='admin-kao19950411'");
    assert.equal((await POST(request())).status,403);
    assert.deepEqual(counts(f.sqlite),[0,0]);
  } finally { f.close(); }
});

test("session revoked between authorization and batch creates no terms", async () => {
  const f=fixture();
  try {
    const original=f.db.batch;
    f.db.batch=async statements => {
      f.sqlite.prepare("DELETE FROM admin_sessions WHERE user_id=?").run("admin-kao19950411");
      return original(statements);
    };
    assert.equal((await POST(request())).status,403);
    assert.deepEqual(counts(f.sqlite),[0,0]);
  } finally { f.close(); }
});
