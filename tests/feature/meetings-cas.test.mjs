import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';

const migrations = readdirSync('drizzle').filter(name => /^[0-9]{4}_.+\.sql$/.test(name)).sort();
const legacyFiles = migrations.filter(name => !name.startsWith('0012_'));
const migration = readFileSync('drizzle/0012_meetings_table.sql', 'utf8');
const workspace = (meetings = [], notices = []) => ({ activities: [], tasks: [], meetings, notices });
const meeting = (id, title) => ({ id, title, activityId: 'activity', time: '2026-11-13T10:00', status: 'planned' });
const notice = (title) => ({ id: 'notice', title, detail: '', createdAt: '2026-11-13', read: false });
const initial = [meeting('m1', 'Before')];

function legacyDatabase(data) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const name of legacyFiles) sqlite.exec(readFileSync('drizzle/' + name, 'utf8'));
  if (data !== undefined) sqlite.prepare('INSERT INTO workspace_states (id,data,version,updated_at,updated_by) VALUES (1,?,5,?,?)').run(data, '2026-01-01', 'seed');
  return sqlite;
}

test('migration preserves every meeting and refuses malformed or duplicate input before schema changes', () => {
  const original = workspace([meeting('a', 'Alpha'), { ...meeting('b', 'Beta'), agenda: '多行\n內容', attendees: ['A'] }]);
  const sqlite = legacyDatabase(JSON.stringify(original));
  try {
    sqlite.exec(migration);
    const rows = sqlite.prepare('SELECT position,activity_id,data FROM meetings ORDER BY position').all();
    assert.deepEqual(rows.map(row => JSON.parse(row.data)), original.meetings);
    assert.deepEqual(rows.map(row => row.position), [0, 1]);
    assert.equal(sqlite.prepare('SELECT data FROM workspace_states WHERE id=1').get().data, JSON.stringify(original));
  } finally { sqlite.close(); }
  for (const value of ['not-json', JSON.stringify({ meetings: {} }), JSON.stringify({ meetings: [{ activityId: 'a' }] }), JSON.stringify({ meetings: [{ id: 'a' }] }), JSON.stringify({ meetings: [meeting('dup', 'A'), meeting('dup', 'B')] })]) {
    const bad = legacyDatabase(value);
    try {
      assert.throws(() => bad.exec(migration));
      assert.equal(bad.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='meetings'").get().n, 0);
      assert.equal(bad.prepare('SELECT data FROM workspace_states WHERE id=1').get().data, value);
    } finally { bad.close(); }
  }
});

globalThis.__meetingsEnv = {};
globalThis.__meetingsUser = { role: 'admin', userId: 'admin', displayName: 'Admin' };
const mockAuth = `export const getMember=async()=>globalThis.__meetingsUser; export const csrfError=r=>r.headers.get('origin')===new URL(r.url).origin?null:new Response(null,{status:403});`;
const mockDeadline = 'export const taskDeadlineError=()=>"";';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export const env=globalThis.__meetingsEnv', shortCircuit: true };
  if (specifier === '@/app/admin-auth') return { url: 'data:text/javascript,' + encodeURIComponent(mockAuth), shortCircuit: true };
  if (specifier === '@/app/task-deadlines') return { url: 'data:text/javascript,' + encodeURIComponent(mockDeadline), shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { GET, PUT } = await import('../../app/api/workspace/route.ts');

function adapter(sqlite) {
  let readBarrier = null, afterRead = null;
  function statement(sql, values = []) {
    return { sql, values,
      bind(...args) { return statement(sql, args); },
      async first() {
        const row = sqlite.prepare(sql).get(...values);
        if (sql.startsWith('SELECT data,version,updated_at,') && afterRead) { const action = afterRead; afterRead = null; action(); }
        if (sql.startsWith('SELECT data,version,updated_at,') && readBarrier) await readBarrier();
        return row ? { ...row } : null;
      },
      async all() { return { success: true, results: sqlite.prepare(sql).all(...values).map(row => ({ ...row })) }; },
    };
  }
  return {
    prepare: sql => statement(sql),
    setBarrier(fn) { readBarrier = fn; },
    setAfterRead(fn) { afterRead = fn; },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(({ sql, values }) => ({ success: true, meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }));
        sqlite.exec('COMMIT'); return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
}
function fixture(existing = true) {
  const sqlite = legacyDatabase(existing ? JSON.stringify(workspace(initial)) : undefined);
  sqlite.exec(migration);
  const db = adapter(sqlite);
  globalThis.__meetingsEnv.DB = db;
  return { sqlite, db };
}
function twoReaders(db) {
  let count = 0, release;
  const ready = new Promise(resolve => { release = resolve; });
  db.setBarrier(async () => { count++; if (count === 2) { db.setBarrier(null); release(); } await ready; });
}
function put(state, version) {
  return PUT(new Request('https://local.test/api/workspace', { method: 'PUT', headers: { origin: 'https://local.test', 'content-type': 'application/json' }, body: JSON.stringify({ state, version, action: 'create_meeting' }) }));
}

for (const existing of [true, false]) for (const reverse of [false, true]) {
  test(`same-millisecond competing writes keep winner (existing=${existing}, reverse=${reverse})`, async () => {
    const { sqlite, db } = fixture(existing);
    const RealDate = Date;
    globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2026-11-13T09:00:00.000Z'])); } };
    try {
      twoReaders(db);
      const version = existing ? 5 : 0;
      const base = existing ? initial : [];
      const one = workspace([...base, meeting('a', 'A')]);
      const two = workspace([...base, meeting('b', 'B')]);
      const results = await Promise.all(reverse ? [put(two, version), put(one, version)] : [put(one, version), put(two, version)]);
      assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
      const winner = (await results[0].json()).version === version + 1 && results[0].status === 200 ? (reverse ? 'B' : 'A') : (reverse ? 'A' : 'B');
      const row = sqlite.prepare('SELECT version FROM workspace_states WHERE id=1').get();
      assert.equal(row.version, version + 1);
      assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n, 1);
      const rows = sqlite.prepare('SELECT data FROM meetings ORDER BY position').all().map(row => JSON.parse(row.data));
      assert.equal(rows.at(-1).title, winner);
      const read = await GET();
      assert.equal(read.status, 200);
      assert.equal((await read.json()).state.meetings.at(-1).title, winner);
    } finally { globalThis.Date = RealDate; sqlite.close(); }
  });
}

test('failing meeting insert rolls back state, audit and meeting rows together', async () => {
  const { sqlite } = fixture();
  try {
    sqlite.exec("CREATE TRIGGER deny_meeting BEFORE INSERT ON meetings BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    await assert.rejects(put(workspace([...initial, meeting('m2', 'New')]), 5));
    assert.equal(sqlite.prepare('SELECT version FROM workspace_states').get().version, 5);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n, 0);
    assert.equal(JSON.parse(sqlite.prepare('SELECT data FROM meetings').get().data).title, 'Before');
  } finally { sqlite.close(); }
});

test('GET pairs workspace version with meetings from one SQL snapshot', async () => {
  const { sqlite, db } = fixture();
  try {
    db.setAfterRead(() => {
      sqlite.prepare('UPDATE workspace_states SET data=?,version=6 WHERE id=1').run(JSON.stringify(workspace([], [notice('New')])));
      sqlite.prepare('UPDATE meetings SET data=? WHERE id=?').run(JSON.stringify(meeting('m1', 'After')), 'm1');
    });
    const response = await GET(), body = await response.json();
    assert.equal(body.version, 5);
    assert.equal(body.state.notices.length, 0);
    assert.equal(body.state.meetings[0].title, 'Before');
    assert.equal(sqlite.prepare('SELECT version FROM workspace_states').get().version, 6);
  } finally { sqlite.close(); }
});

test('rollback draft restores latest ordered meetings and preserves other fields and version safety', async () => {
  for (const rows of [[], [meeting('a', '單筆')], [meeting('a', '中文'), { ...meeting('b', 'Second'), agenda: '多行\n內容', attendees: ['A'] }]]) {
    const state = workspace(rows, [notice('Keep')]);
    const sqlite = legacyDatabase(JSON.stringify(state));
    sqlite.exec(migration);
    globalThis.__meetingsEnv.DB = adapter(sqlite);
    try {
      assert.equal((await put(state, 5)).status, 200);
      const before = sqlite.prepare('SELECT data,version FROM workspace_states WHERE id=1').get();
      assert.deepEqual(JSON.parse(before.data).meetings, []);
      sqlite.exec('BEGIN IMMEDIATE');
      sqlite.exec("UPDATE workspace_states SET data=json_set(data,'$.meetings',json((SELECT json_group_array(json(data)) FROM (SELECT data FROM meetings ORDER BY position)))), version=version+1 WHERE id=1");
      sqlite.exec('COMMIT');
      const after = sqlite.prepare('SELECT data,version FROM workspace_states WHERE id=1').get();
      assert.deepEqual(JSON.parse(after.data), state);
      assert.equal(after.version, before.version + 1);
      assert.equal((await put(state, before.version)).status, 409);
    } finally { sqlite.close(); }
  }
});

test('failed rollback transaction leaves workspace data and version unchanged', async () => {
  const { sqlite } = fixture();
  try {
    assert.equal((await put(workspace([...initial, meeting('m2', 'New')]), 5)).status, 200);
    const before = sqlite.prepare('SELECT data,version FROM workspace_states WHERE id=1').get();
    sqlite.exec("CREATE TRIGGER deny_restore BEFORE UPDATE ON workspace_states BEGIN SELECT RAISE(ABORT, 'injected restore failure'); END");
    sqlite.exec('BEGIN IMMEDIATE');
    assert.throws(() => sqlite.exec("UPDATE workspace_states SET data=json_set(data,'$.meetings',json((SELECT json_group_array(json(data)) FROM (SELECT data FROM meetings ORDER BY position)))), version=version+1 WHERE id=1"), /injected restore failure/);
    sqlite.exec('ROLLBACK');
    assert.deepEqual(sqlite.prepare('SELECT data,version FROM workspace_states WHERE id=1').get(), before);
  } finally { sqlite.close(); }
});

test('rollback draft includes meetings added and edited after migration', async () => {
  const { sqlite } = fixture();
  try {
    const added = workspace([...initial, meeting('m2', 'Added')]);
    assert.equal((await put(added, 5)).status, 200);
    const edited = workspace([meeting('m1', 'Edited'), meeting('m2', 'Added')]);
    const request = new Request('https://local.test/api/workspace', { method: 'PUT', headers: { origin: 'https://local.test', 'content-type': 'application/json' }, body: JSON.stringify({ state: edited, version: 6, action: 'edit_meeting' }) });
    assert.equal((await PUT(request)).status, 200);
    sqlite.exec('BEGIN IMMEDIATE');
    sqlite.exec("UPDATE workspace_states SET data=json_set(data,'$.meetings',json((SELECT json_group_array(json(data)) FROM (SELECT data FROM meetings ORDER BY position)))), version=version+1 WHERE id=1");
    sqlite.exec('COMMIT');
    const row = sqlite.prepare('SELECT data,version FROM workspace_states WHERE id=1').get();
    assert.deepEqual(JSON.parse(row.data), edited);
    assert.equal(row.version, 8);
  } finally { sqlite.close(); }
});
