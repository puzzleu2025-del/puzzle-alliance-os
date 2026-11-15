import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

globalThis.__pushEnv = {}; globalThis.__pushHeaders = new Headers();
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export const env=globalThis.__pushEnv', shortCircuit: true };
  if (specifier === 'next/headers') return { url: 'data:text/javascript,export async function headers(){return globalThis.__pushHeaders}', shortCircuit: true };
  if (specifier.startsWith('@/app/')) return { url: pathToFileURL(path.resolve('app', specifier.slice(6) + '.ts')).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { watchWorkspace } = await import('../../app/workspace-watch.ts');
const { GET } = await import('../../app/api/workspace/events/route.ts');

const files = readdirSync('drizzle').filter(n => /^\d{4}_.+\.sql$/.test(n)).sort();
const hash = t => createHash('sha256').update(t).digest('hex');
const token = 'e'.repeat(64);

function readAll(stream) {
  return new Response(stream).text();
}
function nextChunk(reader) {
  return reader.read().then(({ value, done }) => (done ? null : new TextDecoder().decode(value)));
}

test('watch emits changed when role or version moves and stops on revocation', async () => {
  let snapshot = { role: 'member', version: 1 };
  const stream = watchWorkspace(async () => snapshot, { baseline: { ...snapshot }, intervalMs: 5, });
  const reader = stream.getReader();
  snapshot = { role: 'member', version: 2 };
  assert.match(await nextChunk(reader), /event: changed\ndata: \{"version":2\}\n\n/);
  snapshot = { role: 'coordinator', version: 2 };
  assert.match(await nextChunk(reader), /event: changed\ndata: \{"version":2\}\n\n/);
  snapshot = null;
  assert.match(await nextChunk(reader), /event: revoked/);
  assert.equal(await nextChunk(reader), null);
});

test('watch stays silent while nothing changes and closes on abort', async () => {
  const controller = new AbortController();
  let reads = 0;
  const stream = watchWorkspace(async () => { reads++; return { role: 'admin', version: 7 }; }, { baseline: { role: 'admin', version: 7 }, intervalMs: 5, signal: controller.signal });
  // Wait for at least two polls rather than a fixed delay, so a loaded machine cannot make this flaky.
  for (let waited = 0; reads < 2 && waited < 2000; waited += 5) await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  const text = await readAll(stream);
  assert.equal(text, '');
  assert.ok(reads >= 2);
});

test('a failing read closes the stream instead of leaving a stale connection open', async () => {
  const stream = watchWorkspace(async () => { throw new Error('D1 unavailable'); }, { baseline: { role: 'admin', version: 1 }, intervalMs: 5 });
  assert.equal(await readAll(stream), '');
});

test('watch never sends workspace data, only a version signal', async () => {
  let snapshot = { role: 'admin', version: 1 };
  const stream = watchWorkspace(async () => snapshot, { baseline: { ...snapshot }, intervalMs: 5 });
  const reader = stream.getReader();
  snapshot = { role: 'admin', version: 3 };
  const chunk = await nextChunk(reader);
  assert.deepEqual(Object.keys(JSON.parse(chunk.split('data: ')[1])), ['version']);
  await reader.cancel();
});

function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  for (const f of files) db.exec(readFileSync('drizzle/' + f, 'utf8'));
  db.prepare('INSERT INTO members(user_id,username,email,display_name,role,status,created_at) VALUES(?,?,?,?,?,?,?)').run('member1', 'member123', 'm@example.test', 'Member', 'member', 'active', '2026');
  db.prepare('INSERT INTO admin_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hash(token), 'member1', Date.now() + 60000);
  db.prepare('INSERT INTO workspace_states(id,data,version,updated_at,updated_by) VALUES(1,?,3,?,?)').run('{"activities":[],"tasks":[],"meetings":[],"notices":[]}', '2026', 'member1');
  function stmt(sql, values = []) {
    return { bind: (...v) => stmt(sql, v), async first() { const row = db.prepare(sql).get(...values); return row ? { ...row } : null; } };
  }
  globalThis.__pushEnv.DB = { prepare: sql => stmt(sql) };
  return { db, close() { delete globalThis.__pushEnv.DB; db.close(); } };
}

test('events route rejects missing or unknown sessions before streaming', async () => {
  const f = fixture();
  try {
    globalThis.__pushHeaders = new Headers();
    assert.equal((await GET(new Request('https://puzzle.example/api/workspace/events'))).status, 401);
    globalThis.__pushHeaders = new Headers({ cookie: `puzzle_admin_session=${'f'.repeat(64)}` });
    assert.equal((await GET(new Request('https://puzzle.example/api/workspace/events'))).status, 401);
  } finally { f.close(); }
});

test('events route streams to an authenticated session and ends on client abort', async () => {
  const f = fixture();
  try {
    globalThis.__pushHeaders = new Headers({ cookie: `puzzle_admin_session=${token}` });
    const controller = new AbortController();
    const response = await GET(new Request('https://puzzle.example/api/workspace/events', { signal: controller.signal }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    controller.abort();
    assert.equal(await response.text(), '');
  } finally { f.close(); }
});
