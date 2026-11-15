import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fillOwnRemittance } from '../../app/participant-remittance.ts';
import { submitParticipantRegistration } from '../../app/participant-registration.ts';

const hash = value => createHash('sha256').update(value).digest('hex');
const memberToken = 'a'.repeat(64), participantToken = 'b'.repeat(64), otherToken = 'c'.repeat(64);
const memberCookie = `puzzle_admin_session=${memberToken}`;
const participantCookie = `__Host-puzzle-participant=${participantToken}`;
const otherCookie = `__Host-puzzle-participant=${otherToken}`;
const slug = 'd'.repeat(32);
const secondSlug = 'e'.repeat(32);
const freeSlug = 'f'.repeat(32);

function adapter(sqlite) {
  const statement = (sql, values = []) => ({
    sql,
    values,
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

function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync('drizzle').filter(name => /^[0-9]{4}_.*[.]sql$/.test(name)).sort()) sqlite.exec(readFileSync('drizzle/' + file, 'utf8'));
  sqlite.exec(`INSERT INTO members(user_id,username,email,display_name,role,status,created_at) VALUES ('m1','member1','','Member','member','active','2026');
    INSERT INTO admin_sessions(token_hash,user_id,expires_at) VALUES ('${hash(memberToken)}','m1',4102444800000);
    INSERT INTO participants(id,google_sub,email,display_name,created_at) VALUES ('p1','sub1','p1@example.test','P1','2026'),('p2','sub2','p2@example.test','P2','2026');
    INSERT INTO participant_terms(version,content) VALUES ('v1','Terms');
    INSERT INTO participant_terms_current(id,version) VALUES (1,'v1');
    INSERT INTO participant_consent_state(participant_id,status,epoch,terms_version) VALUES ('p1','active',1,'v1'),('p2','active',1,'v1');
    INSERT INTO participant_sessions(token_hash,participant_id,expires_at,consent_epoch) VALUES ('${hash(participantToken)}','p1',4102444800000,1),('${hash(otherToken)}','p2',4102444800000,1);`);
  const schema = JSON.stringify({ id: 'form', activityId: 'paid', title: 'Title', status: 'open', fields: [], version: 1 });
  sqlite.prepare("INSERT INTO activity_fees(activity_id,amount,revision) VALUES('paid',100,1)").run();
  sqlite.prepare("INSERT INTO registration_forms(id,activity_id,slug,title,description,status,schema_json,privacy_notice,version,created_by,created_at,updated_at) VALUES('form','paid',?,'Title','','open',?,'notice',1,'m1','2026','2026')").run(slug, schema);
  sqlite.prepare("INSERT INTO activity_fees(activity_id,amount,revision) VALUES('paid2',100,1)").run();
  sqlite.prepare("INSERT INTO registration_forms(id,activity_id,slug,title,description,status,schema_json,privacy_notice,version,created_by,created_at,updated_at) VALUES('form2','paid2',?,'Title2','','open',?,'notice',1,'m1','2026','2026')").run(secondSlug, schema.replace('"activityId":"paid"', '"activityId":"paid2"'));
  sqlite.prepare("INSERT INTO registration_forms(id,activity_id,slug,title,description,status,schema_json,privacy_notice,version,created_by,created_at,updated_at) VALUES('form-free','free',?,'Free','','open',?,'notice',1,'m1','2026','2026')").run(freeSlug, schema.replace('"activityId":"paid"', '"activityId":"free"'));
  const addSubmission = (id, formId, owner) => {
    sqlite.prepare("INSERT INTO registration_submissions(id,form_id,form_version,schema_json,answers_json,consent,payment_status,idempotency_hash,source_hash,submitted_at) VALUES(?,?,1,'[]','{}',1,'unpaid',?, 'source','2026-01-01T00:00:00.000Z')").run(id, formId, 'k-' + id);
    if (owner.kind === 'member') sqlite.prepare("INSERT INTO registration_identities(submission_id,form_id,member_id,participant_id,status) VALUES(?,?,?,NULL,'active')").run(id, formId, owner.id);
    else sqlite.prepare("INSERT INTO registration_identities(submission_id,form_id,member_id,participant_id,status) VALUES(?,?,NULL,?,'active')").run(id, formId, owner.id);
  };
  addSubmission('paid-p1', 'form', { kind: 'participant', id: 'p1' });
  addSubmission('paid-p1-other', 'form', { kind: 'participant', id: 'p2' });
  addSubmission('paid-m1', 'form', { kind: 'member', id: 'm1' });
  addSubmission('free-p1', 'form-free', { kind: 'participant', id: 'p1' });
  return { sqlite, db: adapter(sqlite), close: () => sqlite.close() };
}

const remittanceOf = (f, id) => f.sqlite.prepare('SELECT remittance_last5 AS v FROM registration_submissions WHERE id=?').get(id).v;
const auditOf = (f, id) => f.sqlite.prepare("SELECT actor_id AS actor,action FROM audit_logs WHERE entity_id=? AND action='fill_registration_remittance'").all(id).map(row => ({ ...row }));

test('participant fills the missing last five digits of a paid registration once and the audit records it', async () => {
  const f = setup();
  try {
    assert.deepEqual(await fillOwnRemittance(f.db, 'participant', participantCookie, 'paid-p1', '12345'), { ok: true });
    assert.equal(remittanceOf(f, 'paid-p1'), '12345');
    assert.deepEqual(auditOf(f, 'paid-p1'), [{ actor: 'participant', action: 'fill_registration_remittance' }]);
    assert.deepEqual(await fillOwnRemittance(f.db, 'participant', participantCookie, 'paid-p1', '99999'), { ok: false, code: 'already_set' });
    assert.equal(remittanceOf(f, 'paid-p1'), '12345');
    assert.equal(auditOf(f, 'paid-p1').length, 1);
  } finally { f.close(); }
});

test('another participant cannot fill a registration they do not own', async () => {
  const f = setup();
  try {
    assert.deepEqual(await fillOwnRemittance(f.db, 'participant', otherCookie, 'paid-p1', '12345'), { ok: false, code: 'not_found' });
    assert.equal(remittanceOf(f, 'paid-p1'), '');
    assert.equal(auditOf(f, 'paid-p1').length, 0);
  } finally { f.close(); }
});

test('a member fills their own paid registration through the member session', async () => {
  const f = setup();
  try {
    assert.deepEqual(await fillOwnRemittance(f.db, 'member', memberCookie, 'paid-m1', '54321'), { ok: true });
    assert.equal(remittanceOf(f, 'paid-m1'), '54321');
    assert.deepEqual(auditOf(f, 'paid-m1'), [{ actor: 'm1', action: 'fill_registration_remittance' }]);
    assert.deepEqual(await fillOwnRemittance(f.db, 'member', participantCookie, 'paid-m1', '54321'), { ok: false, code: 'unauthorized' });
  } finally { f.close(); }
});

test('free registrations and malformed or unauthenticated requests change nothing', async () => {
  const f = setup();
  try {
    assert.deepEqual(await fillOwnRemittance(f.db, 'participant', participantCookie, 'free-p1', '12345'), { ok: false, code: 'not_required' });
    assert.deepEqual(await fillOwnRemittance(f.db, 'participant', participantCookie, 'paid-p1', '1234'), { ok: false, code: 'invalid' });
    assert.deepEqual(await fillOwnRemittance(f.db, 'participant', participantCookie, 'paid-p1', '12a45'), { ok: false, code: 'invalid' });
    assert.deepEqual(await fillOwnRemittance(f.db, 'participant', participantCookie, 'paid-p1', ''), { ok: false, code: 'invalid' });
    assert.deepEqual(await fillOwnRemittance(f.db, 'participant', null, 'paid-p1', '12345'), { ok: false, code: 'unauthorized' });
    assert.deepEqual(await fillOwnRemittance(f.db, 'participant', `__Host-puzzle-participant=${'e'.repeat(64)}`, 'paid-p1', '12345'), { ok: false, code: 'unauthorized' });
    assert.deepEqual(await fillOwnRemittance(f.db, 'nobody', participantCookie, 'paid-p1', '12345'), { ok: false, code: 'invalid' });
    assert.equal(remittanceOf(f, 'paid-p1'), '');
    assert.equal(remittanceOf(f, 'free-p1'), '');
  } finally { f.close(); }
});

test('a paid registration cannot be submitted without the last five digits, but a free one can', async () => {
  const f = setup();
  try {
    // p1 already holds an active registration on the first paid form, so the new attempt uses the second paid form.
    const base = { answers: {}, consent: true, formVersion: 1, feeRevision: 1 };
    const before = f.sqlite.prepare('SELECT COUNT(*) AS n FROM registration_submissions').get().n;
    assert.deepEqual(await submitParticipantRegistration(f.db, 'participant', participantCookie, secondSlug, { ...base, idempotencyKey: 'no-remit' }), { ok: false, code: 'invalid' });
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM registration_submissions').get().n, before);
    const saved = await submitParticipantRegistration(f.db, 'participant', participantCookie, secondSlug, { ...base, idempotencyKey: 'with-remit', remittanceLast5: '13579' });
    assert.equal(saved.ok, true);
    assert.equal(remittanceOf(f, saved.receiptId), '13579');
    const free = await submitParticipantRegistration(f.db, 'participant', otherCookie, freeSlug, { answers: {}, consent: true, formVersion: 1, feeRevision: 0, idempotencyKey: 'free-ok' });
    assert.equal(free.ok, true);
    assert.equal(remittanceOf(f, free.receiptId), '');
  } finally { f.close(); }
});
