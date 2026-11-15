import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

globalThis.__authEnv = {};
globalThis.__authUser = { userId: 'mgr', role: 'manager', displayName: 'Manager' };
const token = 'a'.repeat(64);
const auth = `export const getMember=async()=>globalThis.__authUser;export const currentToken=async()=>"${token}";export const tokenHash=async()=>"sessionhash";export const randomToken=()=>"b".repeat(64);export const csrfError=r=>r.headers.get('origin')===new URL(r.url).origin?null:new Response(null,{status:403});`;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export const env=globalThis.__authEnv', shortCircuit: true };
  if (specifier === '@/app/admin-auth') return { url: 'data:text/javascript,' + encodeURIComponent(auth), shortCircuit: true };
  if (specifier.startsWith('@/app/')) return { url: pathToFileURL(path.resolve('app', specifier.slice(6) + '.ts')).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { PUT } = await import('../../app/api/workspace/route.ts');

const activity = (overrides) => ({ id: 'a1', name: 'A1', date: '2026-12-01', owner: 'Lead', status: 'planning', description: '', coordinatorIds: [], ...overrides });
const stateWith = (rows) => ({ activities: rows, tasks: [], meetings: [], notices: [] });

function setup(rows) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const f of readdirSync('drizzle').filter(n => /^[0-9]{4}_.*\.sql$/.test(n)).sort()) db.exec(readFileSync('drizzle/' + f, 'utf8'));
  db.exec(`INSERT INTO members(user_id,username,email,display_name,role,status,created_at) VALUES
    ('mgr','manager1','','Manager','manager','active','2026'),
    ('coord','coordinator1','','Lead','coordinator','active','2026'),
    ('coord2','coordinator2','','Other Lead','coordinator','active','2026'),
    ('trainee','trainee1','','Trainee','trainee_coordinator','active','2026'),
    ('member','member1','','Member','member','active','2026');
    INSERT INTO admin_sessions(token_hash,user_id,expires_at) VALUES ('sessionhash','mgr',4102444800000);`);
  db.prepare('INSERT INTO workspace_states(id,data,version,updated_at,updated_by) VALUES(1,?,5,?,?)').run(JSON.stringify(stateWith(rows)), '2026', 'mgr');
  function statement(sql, values = []) {
    return {
      sql, values,
      bind: (...args) => statement(sql, args),
      async first() { const row = db.prepare(sql).get(...values); return row ? { ...row } : null; },
      async all() { return { success: true, results: db.prepare(sql).all(...values).map(r => ({ ...r })) }; },
      async run() { return { success: true, meta: { changes: Number(db.prepare(sql).run(...values).changes) } }; },
    };
  }
  globalThis.__authDb = db;
  globalThis.__authEnv.DB = {
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
  globalThis.__authUser = { userId, role, displayName };
  globalThis.__authDb.prepare("UPDATE admin_sessions SET user_id=?").run(userId);
}

const put = (state, action, version = 5) => PUT(new Request('https://local.test/api/workspace', { method: 'PUT', headers: { origin: 'https://local.test', 'content-type': 'application/json' }, body: JSON.stringify({ state, version, action }) }));
const stored = (db, id) => JSON.parse(db.prepare('SELECT data FROM workspace_states WHERE id=1').get().data).activities.find(row => row.id === id);
const version = (db) => db.prepare('SELECT version FROM workspace_states WHERE id=1').get().version;

test('a coordinator who is not granted any activity can still edit it by default', async () => {
  const db = setup([activity({ id: 'a1' })]);
  try {
    as('coord', 'coordinator', 'Lead');
    const rows = [activity({ id: 'a1', name: 'Renamed' })];
    assert.equal((await put(stateWith(rows), 'edit_activity')).status, 200);
    assert.equal(stored(db, 'a1').name, 'Renamed');
  } finally { db.close(); }
});

test('a coordinator can create an activity; a trainee cannot', async () => {
  const db = setup([activity({ id: 'a1' })]);
  try {
    as('coord', 'coordinator', 'Lead');
    const { coordinatorIds, ...fresh } = activity({ id: 'a2', name: 'New' });
    const created = [activity({ id: 'a1' }), fresh];
    assert.equal((await put(stateWith(created), 'create_activity')).status, 200);
    assert.equal(stored(db, 'a2').name, 'New');
    as('trainee', 'trainee_coordinator', 'Trainee');
    const { coordinatorIds: _unused, ...trainee } = activity({ id: 'a3', name: 'Trainee made' });
    const forbidden = [activity({ id: 'a1' }), fresh, trainee];
    assert.equal((await put(stateWith(forbidden), 'create_activity', version(db))).status, 403);
    assert.equal(stored(db, 'a3'), undefined);
  } finally { db.close(); }
});

test('a coordinator delegates an activity to a trainee; the trainee executes and the coordinator assists', async () => {
  const db = setup([activity({ id: 'a1' })]);
  try {
    as('coord', 'coordinator', 'Lead');
    const delegated = [activity({ id: 'a1', traineeCoordinatorId: 'trainee' })];
    assert.equal((await put(stateWith(delegated), 'assign_activity_authority')).status, 200);
    assert.equal(stored(db, 'a1').traineeCoordinatorId, 'trainee');

    as('trainee', 'trainee_coordinator', 'Trainee');
    assert.equal((await put(stateWith([activity({ id: 'a1', name: 'Trainee edit', traineeCoordinatorId: 'trainee' })]), 'edit_activity', version(db))).status, 200);
    assert.equal(stored(db, 'a1').name, 'Trainee edit');

    as('coord', 'coordinator', 'Lead');
    assert.equal((await put(stateWith([activity({ id: 'a1', name: 'Assist edit', traineeCoordinatorId: 'trainee' })]), 'edit_activity', version(db))).status, 200);
    assert.equal(stored(db, 'a1').name, 'Assist edit');
  } finally { db.close(); }
});

test('only the coordinator level can delegate, and only on open activities', async () => {
  const db = setup([activity({ id: 'a1' }), activity({ id: 'a2', settingsSubmittedAt: '2026-11-14T00:00:00.000Z' })]);
  try {
    as('trainee', 'trainee_coordinator', 'Trainee');
    assert.equal((await put(stateWith([activity({ id: 'a1', traineeCoordinatorId: 'trainee' }), activity({ id: 'a2', settingsSubmittedAt: '2026-11-14T00:00:00.000Z' })]), 'assign_activity_authority')).status, 403);
    as('coord', 'coordinator', 'Lead');
    const locked = [activity({ id: 'a1' }), activity({ id: 'a2', settingsSubmittedAt: '2026-11-14T00:00:00.000Z', traineeCoordinatorId: 'trainee' })];
    assert.equal((await put(stateWith(locked), 'assign_activity_authority')).status, 403);
    assert.equal(stored(db, 'a2').traineeCoordinatorId, undefined);
  } finally { db.close(); }
});

test('a coordinator cannot change the personal-data grant list; a manager can', async () => {
  const db = setup([activity({ id: 'a1' })]);
  try {
    as('coord', 'coordinator', 'Lead');
    assert.equal((await put(stateWith([activity({ id: 'a1', coordinatorIds: ['coord'] })]), 'assign_activity_authority')).status, 403);
    as('mgr', 'manager', 'Manager');
    assert.equal((await put(stateWith([activity({ id: 'a1', coordinatorIds: ['coord'] })]), 'assign_activity_authority', version(db))).status, 200);
    assert.deepEqual(stored(db, 'a1').coordinatorIds, ['coord']);
  } finally { db.close(); }
});

test('a coordinator cannot delegate through an ordinary activity edit', async () => {
  const db = setup([activity({ id: 'a1' })]);
  try {
    as('coord', 'coordinator', 'Lead');
    assert.equal((await put(stateWith([activity({ id: 'a1', traineeCoordinatorId: 'trainee' })]), 'edit_activity')).status, 403);
    assert.equal(stored(db, 'a1').traineeCoordinatorId, undefined);
  } finally { db.close(); }
});
