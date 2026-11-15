import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

globalThis.__linkEnv = {};
const auth = `
import { createHash } from 'node:crypto';
export const csrfError = (request) => (request.headers.get('origin') === new URL(request.url).origin ? null : Response.json({ error: 'csrf' }, { status: 403 }));
export const rateLimited = async () => false;
export const tokenHash = async (token) => createHash('sha256').update(token).digest('hex');
`;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export const env=globalThis.__linkEnv', shortCircuit: true };
  if (specifier === '@/app/admin-auth') return { url: 'data:text/javascript,' + encodeURIComponent(auth), shortCircuit: true };
  if (specifier.startsWith('@/app/')) return { url: pathToFileURL(path.resolve('app', specifier.slice(6) + '.ts')).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const publicApi = await import('../../app/api/public/registrations/[slug]/route.ts');

const activities = [
  { id: 'past', name: 'Past', date: '2020-01-10' },
  { id: 'span', name: 'Span', date: '2020-01-01', endDate: '2099-12-31' },
  { id: 'future', name: 'Future', date: '2099-06-01' },
  { id: 'undated', name: 'Undated' },
];
const slugs = { past: 'a'.repeat(32), span: 'b'.repeat(32), future: 'c'.repeat(32), undated: 'd'.repeat(32) };

function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync('drizzle').filter(name => /^[0-9]{4}_.*[.]sql$/.test(name)).sort()) sqlite.exec(readFileSync('drizzle/' + file, 'utf8'));
  sqlite.prepare('INSERT INTO workspace_states(id,data,version,updated_at,updated_by) VALUES(1,?,1,?,?)').run(JSON.stringify({ activities, tasks: [], meetings: [], notices: [] }), '2026', 'admin-kao19950411');
  for (const id of Object.keys(slugs)) {
    sqlite.prepare("INSERT INTO registration_forms(id,activity_id,slug,title,description,status,schema_json,privacy_notice,version,created_by,created_at,updated_at) VALUES(?,?,?,?,'','open',?,'notice',1,'admin-kao19950411','2026','2026')")
      .run('form-' + id, id, slugs[id], 'Form ' + id, JSON.stringify({ id: 'form-' + id, activityId: id, title: 'Form', status: 'open', fields: [], version: 1 }));
  }
  const statement = (sql, values = []) => ({
    bind: (...args) => statement(sql, args),
    async first() { const row = sqlite.prepare(sql).get(...values); return row ? { ...row } : null; },
    async all() { return { success: true, results: sqlite.prepare(sql).all(...values).map(r => ({ ...r })) }; },
    async run() { return { success: true, meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; },
  });
  globalThis.__linkEnv.DB = { prepare: sql => statement(sql), async batch(list) { return list.map(s => ({ meta: { changes: 0 } })); } };
  return sqlite;
}

const post = (slug, id) => publicApi.POST(new Request(`https://puzzle.example/api/public/registrations/${slug}`, { method: 'POST', headers: { origin: 'https://puzzle.example', 'content-type': 'application/json' }, body: JSON.stringify({ answers: {}, consent: true, idempotencyKey: 'key-' + id, feeRevision: 0 }) }), { params: Promise.resolve({ slug }) });
const get = slug => publicApi.GET(new Request(`https://puzzle.example/api/public/registrations/${slug}`), { params: Promise.resolve({ slug }) });

test('an anonymous link closes once the activity has ended and stays open through its last day', async () => {
  const sqlite = setup();
  try {
    assert.equal((await get(slugs.past)).status, 410);
    assert.equal((await get(slugs.span)).status, 200);
    assert.equal((await get(slugs.future)).status, 200);
    assert.equal((await get(slugs.undated)).status, 200);
    const closed = await post(slugs.past, 'past');
    assert.equal(closed.status, 410);
    assert.equal((await closed.json()).error, '活動已結束，報名已截止');
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM registration_submissions').get().n, 0);
    assert.equal((await post(slugs.span, 'span')).status, 201);
    assert.equal((await post(slugs.future, 'future')).status, 201);
  } finally { sqlite.close(); }
});
