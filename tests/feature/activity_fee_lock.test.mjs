import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

globalThis.__lockEnv = {};
globalThis.__lockUser = { userId: 'mgr', role: 'manager', displayName: 'Manager' };
const token = 'a'.repeat(64);
const auth = `export const getMember=async()=>globalThis.__lockUser;export const currentToken=async()=>"${token}";export const tokenHash=async()=>"sessionhash";export const randomToken=()=>"b".repeat(64);export const csrfError=r=>r.headers.get('origin')===new URL(r.url).origin?null:new Response(null,{status:403});`;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export const env=globalThis.__lockEnv', shortCircuit: true };
  if (specifier === '@/app/admin-auth') return { url: 'data:text/javascript,' + encodeURIComponent(auth), shortCircuit: true };
  if (specifier.startsWith('@/app/')) return { url: pathToFileURL(path.resolve('app', specifier.slice(6) + '.ts')).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { PUT } = await import('../../app/api/workspace/route.ts');

const SUBMITTED_AT = '2026-11-14T00:00:00.000Z';
const activity = (overrides) => ({ id: 'a', name: 'A', date: '2026-12-01', owner: 'Lead', status: 'planning', description: '', coordinatorIds: ['coord'], feeAmount: 0, ...overrides });
const stateWith = (row) => ({ activities: [row], tasks: [], meetings: [], notices: [] });

function setup(seed) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const f of readdirSync('drizzle').filter(n => /^[0-9]{4}_.*\.sql$/.test(n)).sort()) db.exec(readFileSync('drizzle/' + f, 'utf8'));
  db.exec(`INSERT INTO members(user_id,username,email,display_name,role,status,created_at) VALUES ('mgr','manager1','','Manager','manager','active','2026'),('coord','coordinator1','','Lead','coordinator','active','2026'),('other','coordinator2','','Other','coordinator','active','2026'); INSERT INTO admin_sessions(token_hash,user_id,expires_at) VALUES ('sessionhash','mgr',4102444800000);`);
  db.prepare('INSERT INTO workspace_states(id,data,version,updated_at,updated_by) VALUES(1,?,5,?,?)').run(JSON.stringify(stateWith(activity(seed))), '2026', 'mgr');
  function statement(sql, values = []) {
    return {
      sql,
      values,
      bind: (...args) => statement(sql, args),
      async first() { const row = db.prepare(sql).get(...values); return row ? { ...row } : null; },
      async all() { return { success: true, results: db.prepare(sql).all(...values).map(r => ({ ...r })) }; },
      async run() { return { success: true, meta: { changes: Number(db.prepare(sql).run(...values).changes) } }; },
    };
  }
  globalThis.__lockEnv.DB = {
    prepare: s => statement(s),
    async batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = statements.map(s => ({ success: true, meta: { changes: Number(db.prepare(s.sql).run(...s.values).changes) } }));
        db.exec('COMMIT');
        return result;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
  return db;
}

function as(userId, role, displayName) {
  globalThis.__lockUser = { userId, role, displayName };
}

const put = (state) => PUT(new Request('https://local.test/api/workspace', { method: 'PUT', headers: { origin: 'https://local.test', 'content-type': 'application/json' }, body: JSON.stringify({ state, version: 5, action: 'edit_activity' }) }));
const feeRows = (db) => db.prepare('SELECT COUNT(*) AS n FROM activity_fees').get().n;
const workspaceVersion = (db) => db.prepare('SELECT version FROM workspace_states WHERE id=1').get().version;

test('granted coordinator can set the fee while the activity settings are still open', async () => {
  const db = setup({ coordinatorIds: ['coord'] });
  try {
    as('coord', 'coordinator', 'Lead');
    db.exec("UPDATE admin_sessions SET user_id='coord'");
    const result = await put(stateWith(activity({ coordinatorIds: ['coord'], feeAmount: 100 })));
    assert.equal(result.status, 200);
    assert.equal(db.prepare("SELECT amount FROM activity_fees WHERE activity_id='a'").get().amount, 100);
  } finally { db.close(); }
});

test('granted coordinator cannot change the fee after settings are submitted; manager still can', async () => {
  const db = setup({ coordinatorIds: ['coord'], settingsSubmittedAt: SUBMITTED_AT });
  try {
    as('coord', 'coordinator', 'Lead');
    db.exec("UPDATE admin_sessions SET user_id='coord'");
    const locked = await put(stateWith(activity({ coordinatorIds: ['coord'], settingsSubmittedAt: SUBMITTED_AT, feeAmount: 100 })));
    assert.equal(locked.status, 403);
    assert.match((await locked.json()).error, /尚未提交設定/);
    assert.equal(feeRows(db), 0);
    assert.equal(workspaceVersion(db), 5);

    as('mgr', 'manager', 'Manager');
    db.exec("UPDATE admin_sessions SET user_id='mgr'");
    const adjusted = await put(stateWith(activity({ coordinatorIds: ['coord'], settingsSubmittedAt: SUBMITTED_AT, feeAmount: 100 })));
    assert.equal(adjusted.status, 200);
    assert.equal(db.prepare("SELECT amount FROM activity_fees WHERE activity_id='a'").get().amount, 100);
  } finally { db.close(); }
});

test('coordinator who is not granted the activity cannot set its fee', async () => {
  const db = setup({ coordinatorIds: ['other'] });
  try {
    as('coord', 'coordinator', 'Lead');
    db.exec("UPDATE admin_sessions SET user_id='coord'");
    const result = await put(stateWith(activity({ coordinatorIds: ['other'], feeAmount: 100 })));
    assert.equal(result.status, 403);
    assert.match((await result.json()).error, /尚未提交設定/);
    assert.equal(feeRows(db), 0);
    assert.equal(workspaceVersion(db), 5);
  } finally { db.close(); }
});
