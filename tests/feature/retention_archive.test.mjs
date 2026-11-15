import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

globalThis.__retEnv = {};
globalThis.__retUser = null;
const hashOf = value => createHash('sha256').update(value).digest('hex');
const adminToken = 'a'.repeat(64), managerToken = 'b'.repeat(64), participantToken = 'c'.repeat(64);
const auth = `
import { createHash } from 'node:crypto';
export const currentToken = async () => globalThis.__retToken;
export const tokenHash = async (token) => createHash('sha256').update(token).digest('hex');
export const getMember = async () => globalThis.__retUser;
export const getAdmin = async () => (globalThis.__retUser && globalThis.__retUser.role === 'admin' ? globalThis.__retUser : null);
export const csrfError = (request) => (request.headers.get('origin') === new URL(request.url).origin ? null : Response.json({ error: 'csrf' }, { status: 403 }));
export const rateLimited = async () => false;
export const randomToken = () => 'z'.repeat(64);
`;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export const env=globalThis.__retEnv', shortCircuit: true };
  if (specifier === '@/app/admin-auth') return { url: 'data:text/javascript,' + encodeURIComponent(auth), shortCircuit: true };
  if (specifier.startsWith('@/app/')) return { url: pathToFileURL(path.resolve('app', specifier.slice(6) + '.ts')).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const retention = await import('../../app/retention.ts');
const retentionApi = await import('../../app/api/retention/route.ts');
const formsApi = await import('../../app/api/registration-forms/route.ts');
const { listMyRegistrations } = await import('../../app/participant-my-registrations.ts');
const { fillOwnRemittance } = await import('../../app/participant-remittance.ts');

const NOW = new Date('2026-11-15T12:00:00+08:00');
const DUE_CUTOFF = '2023-11-15';

function adapter(sqlite) {
  const statement = (sql, values = []) => ({
    sql, values,
    bind: (...args) => statement(sql, args),
    async first() { const row = sqlite.prepare(sql).get(...values); return row ? { ...row } : null; },
    async all() { return { success: true, results: sqlite.prepare(sql).all(...values).map(row => ({ ...row })) }; },
    async run() { return { success: true, meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; },
  });
  return {
    prepare: sql => statement(sql),
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = statements.map(s => ({ success: true, meta: { changes: Number(sqlite.prepare(s.sql).run(...s.values).changes) } }));
        sqlite.exec('COMMIT');
        return result;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
}

const activities = [
  { id: 'old', name: 'Old', date: '2020-01-10', status: 'done' },
  { id: 'old2', name: 'Old2', date: '2019-05-01', status: 'done' },
  { id: 'recent', name: 'Recent', date: '2025-06-01', status: 'done' },
  { id: 'edge', name: 'Edge', date: '2023-11-15', status: 'done' },
  { id: 'before', name: 'Before', date: '2023-11-14', status: 'done' },
  { id: 'span', name: 'Span', date: '2020-01-01', endDate: '2024-01-01', status: 'done' },
  { id: 'undated', name: 'Undated', status: 'planning' },
];

function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync('drizzle').filter(name => /^[0-9]{4}_.*[.]sql$/.test(name)).sort()) sqlite.exec(readFileSync('drizzle/' + file, 'utf8'));
  sqlite.exec(`INSERT INTO members(user_id,username,email,display_name,role,status,created_at) VALUES
      ('mgr','manager1','','Manager','manager','active','2026'),('m1','member1','','Member One','member','active','2026'),('m2','member2','','Member Two','member','active','2026');
    INSERT INTO admin_sessions(token_hash,user_id,expires_at) VALUES ('${hashOf(adminToken)}','admin-kao19950411',4102444800000),('${hashOf(managerToken)}','mgr',4102444800000);
    INSERT INTO participants(id,google_sub,email,display_name,created_at) VALUES ('p1','sub1','p1@example.test','P1','2026');
    INSERT INTO participant_terms(version,content) VALUES ('v1','Terms');
    INSERT INTO participant_terms_current(id,version) VALUES (1,'v1');
    INSERT INTO participant_consent_state(participant_id,status,epoch,terms_version) VALUES ('p1','active',1,'v1');
    INSERT INTO participant_sessions(token_hash,participant_id,expires_at,consent_epoch) VALUES ('${hashOf(participantToken)}','p1',4102444800000,1);`);
  sqlite.prepare('INSERT INTO workspace_states(id,data,version,updated_at,updated_by) VALUES(1,?,1,?,?)').run(JSON.stringify({ activities, tasks: [], meetings: [], notices: [] }), '2026', 'admin-kao19950411');
  const form = (id, activityId) => sqlite.prepare("INSERT INTO registration_forms(id,activity_id,slug,title,description,status,schema_json,privacy_notice,version,created_by,created_at,updated_at) VALUES(?,?,?,?,'','open',?,'notice',1,'admin-kao19950411','2026','2026')")
    .run(id, activityId, 'slug-' + id, 'Form ' + id, JSON.stringify({ id, activityId, title: 'Form ' + id, status: 'open', fields: [], version: 1 }));
  for (const id of ['old', 'old2', 'recent', 'edge', 'before', 'span', 'undated']) form('f-' + id, id);
  sqlite.prepare("INSERT INTO activity_fees(activity_id,amount,revision) VALUES('old',100,1),('recent',100,1)").run();
  const submission = (id, formId, owner, archivedAt = null) => {
    sqlite.prepare("INSERT INTO registration_submissions(id,form_id,form_version,schema_json,answers_json,consent,payment_status,idempotency_hash,source_hash,submitted_at,archived_at) VALUES(?,?,1,'[]','{}',1,'unpaid',?,'source','2026-01-01T00:00:00.000Z',?)")
      .run(id, formId, 'k-' + id, archivedAt);
    if (owner?.kind === 'member') sqlite.prepare("INSERT INTO registration_identities(submission_id,form_id,member_id,participant_id,status) VALUES(?,?,?,NULL,'active')").run(id, formId, owner.id);
    if (owner?.kind === 'participant') sqlite.prepare("INSERT INTO registration_identities(submission_id,form_id,member_id,participant_id,status) VALUES(?,?,NULL,?,'active')").run(id, formId, owner.id);
  };
  submission('s-old-anon', 'f-old', null);
  submission('s-old-archived', 'f-old', null, '2024-01-01T00:00:00.000Z');
  submission('s-p1-old', 'f-old2', { kind: 'participant', id: 'p1' });
  submission('s-p1-recent', 'f-recent', { kind: 'participant', id: 'p1' });
  submission('s-m1-edge', 'f-edge', { kind: 'member', id: 'm1' });
  submission('s-m2-before', 'f-before', { kind: 'member', id: 'm2' });
  submission('s-undated', 'f-undated', null);
  submission('s-span', 'f-span', { kind: 'member', id: 'm2' });
  sqlite.prepare("INSERT INTO registration_qr_tokens(token_hash,submission_id,issued_at,revoked_at) VALUES('qr-old','s-old-anon',1,NULL)").run();
  const db = adapter(sqlite);
  globalThis.__retEnv.DB = db;
  return { sqlite, db, close: () => sqlite.close() };
}

const as = (user, token) => { globalThis.__retUser = user; globalThis.__retToken = token; };
const admin = { userId: 'admin-kao19950411', role: 'admin', displayName: 'Admin' };
const manager = { userId: 'mgr', role: 'manager', displayName: 'Manager' };
const adminHash = hashOf(adminToken);

test('date helpers: Taipei today, leap-day cutoff and the later of start and end date', () => {
  assert.equal(retention.taipeiDate(new Date('2026-11-14T17:30:00Z')), '2026-11-15');
  assert.equal(retention.taipeiDate(new Date('2026-11-14T15:59:59Z')), '2026-11-14');
  assert.equal(retention.retentionCutoff('2030-02-28', 1), '2029-02-28');
  assert.equal(retention.retentionCutoff('2028-02-29', 1), '2027-03-01');
  assert.equal(retention.activityLastDate({ date: '2020-01-01', endDate: '2024-01-01' }), '2024-01-01');
  assert.equal(retention.activityLastDate({ date: '2020-01-01' }), '2020-01-01');
  assert.equal(retention.activityLastDate({ date: '2020-1-1' }), null);
  assert.equal(retention.activityLastDate({}), null);
  assert.equal(retention.activityLastDate(undefined), null);
  assert.equal(retention.validRetentionYears(0), false);
  assert.equal(retention.validRetentionYears(11), false);
  assert.equal(retention.validRetentionYears('3'), false);
  assert.equal(retention.validRetentionYears(3), true);
});

test('plan archives only people whose last activity is before the cutoff, keeps people with recent activity, and holds undated records', async () => {
  const f = setup();
  try {
    const plan = await retention.planRetention(f.db, NOW);
    assert.equal(plan.retentionYears, 3);
    assert.equal(plan.cutoff, DUE_CUTOFF);
    assert.deepEqual(plan.dueSubmissionIds, ['s-old-anon']);
    assert.equal(plan.heldWithoutActivity, 1);
    assert.equal(plan.alreadyArchived, 1);
  } finally { f.close(); }
});

test('a person whose latest activity is recent keeps every registration, including older ones', async () => {
  const f = setup();
  try {
    const plan = await retention.planRetention(f.db, NOW);
    assert.equal(plan.dueSubmissionIds.includes('s-p1-old'), false);
    assert.equal(plan.dueSubmissionIds.includes('s-p1-recent'), false);
    // m2 has an older 'before' registration, but a span registration that ended in 2024 keeps the whole group.
    assert.equal(plan.dueSubmissionIds.includes('s-span'), false);
    assert.equal(plan.dueSubmissionIds.includes('s-m2-before'), false);
    // An activity exactly on the cutoff is not yet expired.
    assert.equal(plan.dueSubmissionIds.includes('s-m1-edge'), false);
  } finally { f.close(); }
});

test('changing the setting changes the cutoff; out-of-range settings are rejected', async () => {
  const f = setup();
  try {
    f.sqlite.exec("UPDATE data_retention_settings SET retention_years=1 WHERE id=1");
    const plan = await retention.planRetention(f.db, NOW);
    assert.equal(plan.cutoff, '2025-11-15');
    // p1's latest activity (2025-06-01) is now older than one year, so the whole group is due.
    assert.ok(plan.dueSubmissionIds.includes('s-p1-old'));
    assert.ok(plan.dueSubmissionIds.includes('s-p1-recent'));
    // The table itself refuses out-of-range years, so a stored value can never reach the planner.
    assert.throws(() => f.sqlite.exec('UPDATE data_retention_settings SET retention_years=11 WHERE id=1'), /CHECK constraint/);
  } finally { f.close(); }
});

test('archiving stamps only due records, revokes their QR codes, writes one audit row, and needs a live administrator', async () => {
  const f = setup();
  try {
    const plan = await retention.planRetention(f.db, NOW);
    const denied = await retention.archiveRegistrations(f.db, plan.dueSubmissionIds, NOW, { tokenHash: hashOf(managerToken), userId: 'mgr' });
    assert.deepEqual(denied, { archived: 0 });
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='archive_registrations'").get().n, 0);

    const done = await retention.archiveRegistrations(f.db, plan.dueSubmissionIds, NOW, { tokenHash: adminHash, userId: 'admin-kao19950411' });
    assert.deepEqual(done, { archived: 1 });
    assert.equal(f.sqlite.prepare("SELECT archived_at IS NOT NULL AS a FROM registration_submissions WHERE id='s-old-anon'").get().a, 1);
    assert.equal(f.sqlite.prepare("SELECT archived_at AS a FROM registration_submissions WHERE id='s-p1-old'").get().a, null);
    assert.equal(f.sqlite.prepare("SELECT revoked_at IS NOT NULL AS r FROM registration_qr_tokens WHERE token_hash='qr-old'").get().r, 1);
    assert.deepEqual(f.sqlite.prepare("SELECT actor_id AS actor,entity_id AS n FROM audit_logs WHERE action='archive_registrations'").all().map(row => ({ ...row })), [{ actor: 'admin-kao19950411', n: '1' }]);

    const after = await retention.planRetention(f.db, NOW);
    assert.deepEqual(after.dueSubmissionIds, []);
    assert.equal(after.alreadyArchived, 2);
  } finally { f.close(); }
});

test('retention API is administrator-only, validates years and reports status', async () => {
  const f = setup();
  try {
    const origin = { origin: 'https://puzzle.example' };
    const get = () => retentionApi.GET(new Request('https://puzzle.example/api/retention'));
    as(manager, managerToken);
    assert.equal((await get()).status, 403);
    as(admin, adminToken);
    const status = await get();
    assert.equal(status.status, 200);
    const statusBody = await status.json();
    assert.equal(statusBody.retentionYears, 3);
    assert.equal(statusBody.minYears, 1);
    assert.equal(statusBody.maxYears, 10);
    assert.equal(statusBody.archivedCount, 1);
    assert.equal(statusBody.heldWithoutActivity, 1);
    // The route uses the wall clock; the 2020 registration is past any three-year window, so at least it is due.
    assert.ok(statusBody.dueCount >= 1);

    const put = (body, headers = origin, user = admin, token = adminToken) => { as(user, token); return retentionApi.PUT(new Request('https://puzzle.example/api/retention', { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })); };
    assert.equal((await put({ retentionYears: 2 }, origin, manager, managerToken)).status, 403);
    assert.equal((await put({ retentionYears: 2 }, {})).status, 403);
    assert.equal((await put({ retentionYears: 0 })).status, 400);
    assert.equal((await put({ retentionYears: 11 })).status, 400);
    assert.equal((await put({ retentionYears: '2' })).status, 400);
    assert.equal(f.sqlite.prepare('SELECT retention_years AS y FROM data_retention_settings WHERE id=1').get().y, 3);
    assert.equal((await put({ retentionYears: 2 })).status, 200);
    assert.equal(f.sqlite.prepare('SELECT retention_years AS y FROM data_retention_settings WHERE id=1').get().y, 2);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='update_retention_years'").get().n, 1);

    const post = (headers = origin, user = admin, token = adminToken) => { as(user, token); return retentionApi.POST(new Request('https://puzzle.example/api/retention', { method: 'POST', headers })); };
    assert.equal((await post({}, manager, managerToken)).status, 403);
    assert.equal((await post({})).status, 403);
    const run = await post();
    assert.equal(run.status, 200);
    const body = await run.json();
    assert.ok(body.archived >= 1);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM registration_submissions WHERE archived_at IS NOT NULL").get().n, 1 + body.archived);
  } finally { f.close(); }
});

test('archived registrations are hidden from managers, participants and QR issue, and shown to administrators with a flag', async () => {
  const f = setup();
  try {
    await retention.archiveRegistrations(f.db, ['s-old-anon'], NOW, { tokenHash: adminHash, userId: 'admin-kao19950411' });
    const forms = (user, token) => { as(user, token); return formsApi.GET(new Request('https://puzzle.example/api/registration-forms?activityId=old')); };
    const managerView = await (await forms(manager, managerToken)).json();
    assert.ok(!managerView.submissions.some(row => row.id === 's-old-archived' || row.id === 's-old-anon'));
    const adminView = await (await forms(admin, adminToken)).json();
    assert.deepEqual(adminView.submissions.filter(row => row.archivedAt).map(row => row.id).sort(), ['s-old-anon', 's-old-archived']);

    f.sqlite.exec("UPDATE registration_submissions SET archived_at='2024-01-01T00:00:00.000Z' WHERE id='s-p1-old'");
    const afterArchive = await listMyRegistrations(f.db, 'participant', `__Host-puzzle-participant=${participantToken}`);
    assert.deepEqual(afterArchive.registrations.map(row => row.submissionId), ['s-p1-recent']);
    assert.deepEqual(await fillOwnRemittance(f.db, 'participant', `__Host-puzzle-participant=${participantToken}`, 's-p1-old', '12345'), { ok: false, code: 'not_found' });
  } finally { f.close(); }
});
