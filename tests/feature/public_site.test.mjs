import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Same harness approach as retention_archive.test.mjs: real migrations, in-memory SQLite, D1-like adapter.
globalThis.__siteEnv = {};
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export const env=globalThis.__siteEnv', shortCircuit: true };
  if (specifier.startsWith('@/app/')) return { url: pathToFileURL(path.resolve('app', specifier.slice(6) + '.ts')).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { readPublicSite } = await import('../../app/site-public.ts');

const NOW = new Date('2026-11-15T12:00:00+08:00');

function adapter(sqlite) {
  const statement = (sql, values = []) => ({
    sql, values,
    bind: (...args) => statement(sql, args),
    async first() { const row = sqlite.prepare(sql).get(...values); return row ? { ...row } : null; },
    async all() { return { success: true, results: sqlite.prepare(sql).all(...values).map(row => ({ ...row })) }; },
    async run() { return { success: true, meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; },
  });
  return { prepare: sql => statement(sql) };
}

const activities = [
  // Opted in, open form, upcoming: the only one that should expose a registration link.
  { id: 'open', publicListing: true, name: 'Open Day', date: '2026-12-01', location: 'Hall A', status: 'planning', notes: 'internal note', fee: 500 },
  // Not opted in (no publicListing flag) even though it has an open form.
  { id: 'private', name: 'Private Meeting', date: '2026-12-05', location: 'Office', status: 'planning' },
  // Opted in explicitly false.
  { id: 'explicit-false', publicListing: false, name: 'Hidden Event', date: '2026-12-06', location: 'Office', status: 'planning' },
  // Opted in, form exists but is closed.
  { id: 'closed', publicListing: true, name: 'Closed Form', date: '2026-12-02', location: 'Gym', status: 'planning' },
  // Opted in, form open, but the activity ended before today.
  { id: 'ended', publicListing: true, name: 'Ended Trip', date: '2026-10-01', endDate: '2026-10-03', location: 'Coast', status: 'done' },
  // Opted in, form open, ends today: still open (last day is inclusive).
  { id: 'today', publicListing: true, name: 'Today Only', date: '2026-11-10', endDate: '2026-11-15', location: 'Park', status: 'planning' },
  // Opted in, no registration form at all.
  { id: 'no-form', publicListing: true, name: 'No Form Yet', date: '2026-12-10', location: 'Room 3', status: 'planning' },
];

function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync('drizzle').filter(name => /^[0-9]{4}_.*[.]sql$/.test(name)).sort()) sqlite.exec(readFileSync('drizzle/' + file, 'utf8'));
  sqlite.exec(`INSERT INTO members(user_id,username,email,display_name,role,status,created_at) VALUES ('mgr','manager1','','Manager','manager','active','2026');`);
  sqlite.prepare('INSERT INTO workspace_states(id,data,version,updated_at,updated_by) VALUES(1,?,1,?,?)')
    .run(JSON.stringify({ activities, tasks: [{ id: 't1', name: 'internal task' }], meetings: [], notices: [] }), '2026', 'mgr');
  const form = (id, activityId, status) => sqlite.prepare("INSERT INTO registration_forms(id,activity_id,slug,title,description,status,schema_json,privacy_notice,version,created_by,created_at,updated_at) VALUES(?,?,?,?,'',?,?,'notice',1,'mgr','2026','2026')")
    .run(id, activityId, 'slug-' + id, 'Form ' + id, status, JSON.stringify({ id, activityId, title: 'Form ' + id, status, fields: [], version: 1 }));
  form('f-open', 'open', 'open');
  form('f-private', 'private', 'open');
  form('f-explicit', 'explicit-false', 'open');
  form('f-closed', 'closed', 'closed');
  form('f-ended', 'ended', 'open');
  form('f-today', 'today', 'open');
  const announcement = (id, title, body, published, updatedAt) => sqlite.prepare('INSERT INTO site_announcements(id,title,body,published,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(id, title, body, published, 'mgr', '2026-11-01T00:00:00.000Z', updatedAt);
  announcement('a-shown', 'Shown notice', 'Line one\nLine two', 1, '2026-11-14T01:00:00.000Z');
  announcement('a-hidden', 'Draft notice', 'Not ready', 0, '2026-11-15T01:00:00.000Z');
  announcement('a-older', 'Older notice', 'Older body', 1, '2026-11-02T01:00:00.000Z');
  globalThis.__siteEnv.DB = adapter(sqlite);
  return sqlite;
}

const sqlite = setup();
const site = await readPublicSite(globalThis.__siteEnv.DB, NOW);
const byId = new Map(site.activities.map(item => [item.id, item]));

test('an activity that is not opted in is absent', () => {
  assert.equal(byId.has('private'), false);
  assert.equal(byId.has('explicit-false'), false);
  assert.equal(site.activities.some(item => item.name === 'Private Meeting' || item.name === 'Hidden Event'), false);
});

test('an opted-in activity exposes only the allowed fields', () => {
  const open = byId.get('open');
  assert.ok(open, 'opted-in activity is present');
  assert.deepEqual(Object.keys(open).sort(), ['date', 'endDate', 'id', 'location', 'name', 'registrationSlug', 'status']);
  assert.equal(open.name, 'Open Day');
  assert.equal(open.location, 'Hall A');
  assert.equal(open.date, '2026-12-01');
  assert.equal(open.endDate, null);
  assert.equal(open.status, 'planning');
  assert.equal(JSON.stringify(site).includes('internal note'), false);
  assert.equal(JSON.stringify(site).includes('500'), false);
  assert.equal(JSON.stringify(site).includes('internal task'), false);
  for (const item of site.activities) assert.deepEqual(Object.keys(item).sort(), ['date', 'endDate', 'id', 'location', 'name', 'registrationSlug', 'status']);
});

test('registrationSlug is set only for an open form on an activity that has not ended', () => {
  assert.equal(byId.get('open').registrationSlug, 'slug-f-open');
  assert.equal(byId.get('today').registrationSlug, 'slug-f-today', 'an activity whose last day is today is still open');
  assert.equal(byId.get('closed').registrationSlug, null, 'closed form has no slug');
  assert.equal(byId.get('ended').registrationSlug, null, 'ended activity has no slug');
  assert.equal(byId.get('no-form').registrationSlug, null, 'no form means no slug');
});

test('activities are listed in date order', () => {
  const dates = site.activities.map(item => item.date);
  assert.deepEqual(dates, [...dates].sort());
});

test('unpublished announcements are absent and published ones carry only public fields', () => {
  const titles = site.announcements.map(item => item.title);
  assert.equal(titles.includes('Draft notice'), false);
  assert.deepEqual(titles, ['Shown notice', 'Older notice'], 'newest first');
  for (const item of site.announcements) assert.deepEqual(Object.keys(item).sort(), ['body', 'id', 'title', 'updatedAt']);
  assert.equal(site.announcements[0].body, 'Line one\nLine two', 'line breaks are kept as stored');
});

test('an unreadable workspace row degrades to no activities instead of throwing', async () => {
  sqlite.prepare("UPDATE workspace_states SET data='not json' WHERE id=1").run();
  const degraded = await readPublicSite(globalThis.__siteEnv.DB, NOW);
  assert.deepEqual(degraded.activities, []);
  assert.equal(degraded.announcements.length, 2);
  sqlite.close();
});
