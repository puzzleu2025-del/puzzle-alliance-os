import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';

const files = readdirSync('drizzle').filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
const target = '0013_participant_member_links.sql';
assert.ok(files.includes(target));
const apply = (db, names) => { for (const name of names) db.exec(readFileSync(`drizzle/${name}`, 'utf8')); };
function database(names) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  apply(db, names);
  return db;
}
function seed(db) {
  db.exec(`
    INSERT INTO members (user_id,username,email,display_name,role,status,created_at)
      VALUES ('member-1','member-one','same@example.test','Member','member','active','2026-01-01');
    INSERT INTO participants (id,google_sub,email,display_name,created_at)
      VALUES ('participant-1','google-sub','same@example.test','Participant','2026-01-01');
    INSERT INTO registration_forms (id,activity_id,slug,title,description,status,schema_json,privacy_notice,version,created_by,created_at,updated_at)
      VALUES ('form-1','activity-1','test-form','Form','','active','{}','',1,'member-1','2026-01-01','2026-01-01');
    INSERT INTO registration_submissions (id,form_id,form_version,schema_json,answers_json,consent,idempotency_hash,source_hash,submitted_at)
      VALUES ('submission-1','form-1',1,'{}','{}',1,'idempotency-1','source-1','2026-01-01');
    INSERT INTO registration_identities (submission_id,form_id,participant_id,status)
      VALUES ('submission-1','form-1','participant-1','active');
    INSERT INTO registration_qr_tokens (token_hash,submission_id,issued_at)
      VALUES ('token-hash','submission-1',123);
  `);
}
const rows = (db, table) => db.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row }));

test('fresh database has an empty reserved link table', () => {
  const db = database(files);
  try {
    assert.deepEqual(rows(db, 'participant_member_links'), []);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { db.close(); }
});

test('upgrade never links same-email accounts and preserves registration and QR rows', () => {
  const db = database(files.filter(name => name < target));
  try {
    seed(db);
    const old = Object.fromEntries(['members', 'participants', 'registration_submissions', 'registration_identities', 'registration_qr_tokens'].map(table => [table, rows(db, table)]));
    apply(db, [target]);
    assert.deepEqual(rows(db, 'participant_member_links'), []);
    for (const [table, before] of Object.entries(old)) assert.deepEqual(rows(db, table), before, table);
    assert.throws(() => db.prepare("UPDATE registration_identities SET member_id='member-1' WHERE submission_id='submission-1'").run(), /CHECK constraint failed/);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { db.close(); }
});

test('link rows require existing participant, member and actor; duplicate pairs are rejected', () => {
  const db = database(files);
  try {
    seed(db);
    const insert = db.prepare('INSERT INTO participant_member_links (participant_id,member_id,linked_at,linked_by) VALUES (?,?,?,?)');
    for (const args of [
      ['missing','member-1','2026-01-01','member-1'],
      ['participant-1','missing','2026-01-01','member-1'],
      ['participant-1','member-1','2026-01-01','missing'],
    ]) assert.throws(() => insert.run(...args), /FOREIGN KEY constraint failed/);
    insert.run('participant-1','member-1','2026-01-01','member-1');
    assert.throws(() => insert.run('participant-1','member-1','2026-02-01','member-1'), /UNIQUE constraint failed/);
    assert.equal(rows(db, 'participant_member_links').length, 1);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { db.close(); }
});
