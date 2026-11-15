import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

globalThis.__annEnv = {};
globalThis.__annUser = null;
const auth = `
import { createHash } from 'node:crypto';
export const currentToken = async () => globalThis.__annToken;
export const tokenHash = async (token) => createHash('sha256').update(token).digest('hex');
export const getMember = async () => globalThis.__annUser;
export const csrfError = (request) => (request.headers.get('origin') === new URL(request.url).origin ? null : Response.json({ error: 'csrf' }, { status: 403 }));
`;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export const env=globalThis.__annEnv', shortCircuit: true };
  if (specifier === '@/app/admin-auth') return { url: 'data:text/javascript,' + encodeURIComponent(auth), shortCircuit: true };
  if (specifier.startsWith('@/app/')) return { url: pathToFileURL(path.resolve('app', specifier.slice(6) + '.ts')).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const api = await import('../../app/api/site/announcements/route.ts');
const { readPublicSite } = await import('../../app/site-public.ts');

const hashOf = v => createHash('sha256').update(v).digest('hex');
const managerToken = 'a'.repeat(64), memberToken = 'b'.repeat(64);

function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync('drizzle').filter(name => /^[0-9]{4}_.*[.]sql$/.test(name)).sort()) sqlite.exec(readFileSync('drizzle/' + file, 'utf8'));
  sqlite.exec(`INSERT INTO members(user_id,username,email,display_name,role,status,created_at) VALUES
    ('mgr','manager1','','Manager','manager','active','2026'),('mem','member1','','Member','member','active','2026');
    INSERT INTO admin_sessions(token_hash,user_id,expires_at) VALUES ('${hashOf(managerToken)}','mgr',4102444800000),('${hashOf(memberToken)}','mem',4102444800000);`);
  const statement = (sql, values = []) => ({
    sql, values,
    bind: (...args) => statement(sql, args),
    async first() { const row = sqlite.prepare(sql).get(...values); return row ? { ...row } : null; },
    async all() { return { success: true, results: sqlite.prepare(sql).all(...values).map(r => ({ ...r })) }; },
    async run() { return { success: true, meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; },
  });
  globalThis.__annEnv.DB = {
    prepare: s => statement(s),
    async batch(list) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const out = list.map(s => ({ success: true, meta: { changes: Number(sqlite.prepare(s.sql).run(...s.values).changes) } }));
        sqlite.exec('COMMIT');
        return out;
      } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    },
  };
  return sqlite;
}

const as = (user, token) => { globalThis.__annUser = user; globalThis.__annToken = token; };
const mgr = { userId: 'mgr', role: 'manager', displayName: 'Manager' };
const mem = { userId: 'mem', role: 'member', displayName: 'Member' };
const origin = { origin: 'https://puzzle.example' };
const post = (body) => api.POST(new Request('https://puzzle.example/api/site/announcements', { method: 'POST', headers: { ...origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const put = (body) => api.PUT(new Request('https://puzzle.example/api/site/announcements', { method: 'PUT', headers: { ...origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const del = (body) => api.DELETE(new Request('https://puzzle.example/api/site/announcements', { method: 'DELETE', headers: { ...origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }));

test('members cannot read or write announcements; managers can create, publish, and delete', async () => {
  const sqlite = setup();
  try {
    as(mem, memberToken);
    assert.equal((await post({ title: 'x', body: 'y', published: true })).status, 403);
    assert.equal((await api.GET()).status, 403);
    as(mgr, managerToken);
    const created = await post({ title: '年度大會', body: '報名截止日已延後。', published: true });
    assert.equal(created.status, 201);
    const { id } = await created.json();
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM site_announcements').get().n, 1);
    assert.equal((await put({ id, title: '年度大會', body: '內容改了', published: false })).status, 200);
    assert.equal((await del({ id })).status, 200);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM site_announcements').get().n, 0);
  } finally { sqlite.close(); }
});

test('public read shows only published announcements and only opted-in activities', async () => {
  const sqlite = setup();
  try {
    as(mgr, managerToken);
    await post({ title: '公開消息', body: '內容', published: true });
    await post({ title: '草稿消息', body: '內容', published: false });
    sqlite.exec(`INSERT INTO workspace_states(id,data,version,updated_at,updated_by) VALUES (1,'${JSON.stringify({ activities: [
      { id: 'pub', name: '公開活動', date: '2026-12-01', owner: 'A', status: 'planning', description: '內部備註不可公開', coordinatorIds: [], publicListing: true },
      { id: 'priv', name: '私人活動', date: '2026-12-02', owner: 'B', status: 'planning', description: '', coordinatorIds: [] },
    ], tasks: [], meetings: [], notices: [] }).replace(/'/g, "''")}',1,'2026','mgr')`);
    const site = await readPublicSite(globalThis.__annEnv.DB, new Date('2026-11-15T12:00:00+08:00'));
    assert.deepEqual(site.announcements.map(row => row.title), ['公開消息']);
    assert.deepEqual(site.activities.map(row => row.id), ['pub']);
    assert.ok(!('description' in site.activities[0]));
    assert.ok(!('owner' in site.activities[0]));
  } finally { sqlite.close(); }
});
