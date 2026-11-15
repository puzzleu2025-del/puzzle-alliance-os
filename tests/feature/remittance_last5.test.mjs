import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

globalThis.__remEnv = {};
globalThis.__remUser = { userId: 'mgr', role: 'manager', displayName: 'Manager' };
const token = 'a'.repeat(64);
const auth = `export const getMember=async()=>globalThis.__remUser;export const currentToken=async()=>"${token}";export const tokenHash=async()=>"sessionhash";export const randomToken=()=>"b".repeat(64);export const rateLimited=async()=>false;export const csrfError=()=>null;`;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export const env=globalThis.__remEnv', shortCircuit: true };
  if (specifier === '@/app/admin-auth') return { url: 'data:text/javascript,' + encodeURIComponent(auth), shortCircuit: true };
  if (specifier.startsWith('@/app/')) return { url: pathToFileURL(path.resolve('app', specifier.slice(6) + '.ts')).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { normalizeRemittanceLast5 } = await import('../../app/registration-types.ts');
const publicApi = await import('../../app/api/public/registrations/[slug]/route.ts');
const formsApi = await import('../../app/api/registration-forms/route.ts');

const slug = 'c'.repeat(32);
const formSchema = { id: 'form', activityId: 'a', title: 'Title', status: 'open', fields: [], version: 1 };

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const f of readdirSync('drizzle').filter(n => /^[0-9]{4}_.*\.sql$/.test(n)).sort()) db.exec(readFileSync('drizzle/' + f, 'utf8'));
  db.exec(`INSERT INTO members(user_id,username,email,display_name,role,status,created_at) VALUES ('mgr','manager1','','Manager','manager','active','2026'),('person','person1','','Person','member','active','2026'),('trainee','trainee1','','Trainee','trainee_coordinator','active','2026'); INSERT INTO admin_sessions(token_hash,user_id,expires_at) VALUES ('sessionhash','mgr',4102444800000);`);
  db.prepare('INSERT INTO workspace_states(id,data,version,updated_at,updated_by) VALUES(1,?,1,?,?)').run(JSON.stringify({ activities: [{ id: 'a', name: 'A', date: '2026-12-01', owner: 'Lead', status: 'planning', description: '', coordinatorIds: [], feeAmount: 100 }], tasks: [], meetings: [], notices: [] }), '2026', 'mgr');
  db.prepare("INSERT INTO activity_fees(activity_id,amount,revision) VALUES('a',100,1)").run();
  db.prepare("INSERT INTO registration_forms(id,activity_id,slug,title,description,status,schema_json,privacy_notice,version,created_by,created_at,updated_at) VALUES('form','a',?,'Title','','open',?,'notice',1,'mgr','2026','2026')").run(slug, JSON.stringify(formSchema));
  db.prepare("INSERT INTO registration_submissions(id,form_id,form_version,schema_json,answers_json,consent,payment_status,idempotency_hash,source_hash,submitted_at) VALUES('anon','form',1,'[]','{}',1,'unpaid','h-anon','s','2026')").run();
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
  globalThis.__remEnv.DB = {
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
  globalThis.__remUser = { userId: 'mgr', role: 'manager', displayName: 'Manager' };
  return db;
}

const submit = (body) => publicApi.POST(new Request(`https://local.test/api/public/registrations/${slug}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ slug }) });
const patch = (body) => formsApi.PATCH(new Request('https://local.test/api/registration-forms', { method: 'PATCH', headers: { origin: 'https://local.test', 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const remittanceOf = (db, id) => db.prepare('SELECT remittance_last5 AS v FROM registration_submissions WHERE id=?').get(id).v;

test('normalizer accepts empty or exactly five digits and rejects everything else', () => {
  assert.equal(normalizeRemittanceLast5(undefined), '');
  assert.equal(normalizeRemittanceLast5(null), '');
  assert.equal(normalizeRemittanceLast5('  '), '');
  assert.equal(normalizeRemittanceLast5(' 01234 '), '01234');
  assert.equal(normalizeRemittanceLast5('1234'), null);
  assert.equal(normalizeRemittanceLast5('123456'), null);
  assert.equal(normalizeRemittanceLast5('12a45'), null);
  assert.equal(normalizeRemittanceLast5(12345), null);
});

test('anonymous paid registration stores valid last five digits and rejects malformed input without writing', async () => {
  const db = setup();
  try {
    const ok = await submit({ answers: {}, consent: true, idempotencyKey: 'k-ok', feeRevision: 1, remittanceLast5: ' 01234 ' });
    assert.equal(ok.status, 201);
    const { receiptId } = await ok.json();
    assert.equal(remittanceOf(db, receiptId), '01234');
    const before = db.prepare('SELECT COUNT(*) AS n FROM registration_submissions').get().n;
    const bad = await submit({ answers: {}, consent: true, idempotencyKey: 'k-bad', feeRevision: 1, remittanceLast5: '12ab' });
    assert.equal(bad.status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM registration_submissions').get().n, before);
  } finally { db.close(); }
});

test('staff backfill sets the value on an anonymous submission and writes an audit row', async () => {
  const db = setup();
  try {
    const result = await patch({ action: 'remittance', formId: 'form', submissionId: 'anon', remittanceLast5: '98765' });
    assert.equal(result.status, 200);
    assert.equal(remittanceOf(db, 'anon'), '98765');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='update_registration_remittance' AND entity_id='anon'").get().n, 1);
  } finally { db.close(); }
});

test('staff backfill rejects malformed values and leaves the record unchanged', async () => {
  const db = setup();
  try {
    assert.equal((await patch({ action: 'remittance', formId: 'form', submissionId: 'anon', remittanceLast5: '9876' })).status, 400);
    assert.equal(remittanceOf(db, 'anon'), '');
  } finally { db.close(); }
});

test('members without registration access and trainee coordinators cannot backfill', async () => {
  const db = setup();
  try {
    db.exec("UPDATE admin_sessions SET user_id='person' WHERE token_hash='sessionhash'");
    globalThis.__remUser = { userId: 'person', role: 'member', displayName: 'Person' };
    assert.equal((await patch({ action: 'remittance', formId: 'form', submissionId: 'anon', remittanceLast5: '11111' })).status, 403);
    globalThis.__remUser = { userId: 'trainee', role: 'trainee_coordinator', displayName: 'Trainee' };
    assert.equal((await patch({ action: 'remittance', formId: 'form', submissionId: 'anon', remittanceLast5: '11111' })).status, 403);
    assert.equal(remittanceOf(db, 'anon'), '');
  } finally { db.close(); }
});
