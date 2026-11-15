import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Same harness as site_announcements.test.mjs: real migrations, in-memory SQLite, D1-like adapter, hashed session tokens.
globalThis.__contentEnv = {};
globalThis.__contentUser = null;
const auth = `
import { createHash } from 'node:crypto';
export const currentToken = async () => globalThis.__contentToken;
export const tokenHash = async (token) => createHash('sha256').update(token).digest('hex');
export const getMember = async () => globalThis.__contentUser;
export const csrfError = (request) => (request.headers.get('origin') === new URL(request.url).origin ? null : Response.json({ error: 'csrf' }, { status: 403 }));
`;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export const env=globalThis.__contentEnv', shortCircuit: true };
  if (specifier === '@/app/admin-auth') return { url: 'data:text/javascript,' + encodeURIComponent(auth), shortCircuit: true };
  if (specifier.startsWith('@/app/')) return { url: pathToFileURL(path.resolve('app', specifier.slice(6) + '.ts')).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const api = await import('../../app/api/site/content/route.ts');
const { readSiteContent, buildSiteContent, DEFAULT_SITE_CONTENT, SITE_CONTENT_LIMITS } = await import('../../app/site-content.ts');

const hashOf = v => createHash('sha256').update(v).digest('hex');
const managerToken = 'c'.repeat(64), memberToken = 'd'.repeat(64);
const ORIGIN = 'https://puzzle.example';

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
  globalThis.__contentEnv.DB = {
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

const as = (user, token) => { globalThis.__contentUser = user; globalThis.__contentToken = token; };
const mgr = { userId: 'mgr', role: 'manager', displayName: 'Manager' };
const mem = { userId: 'mem', role: 'member', displayName: 'Member' };
const put = (body, origin = ORIGIN) => api.PUT(new Request(`${ORIGIN}/api/site/content`, { method: 'PUT', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const get = (query = '') => api.GET(new Request(`${ORIGIN}/api/site/content${query}`));
const clone = value => JSON.parse(JSON.stringify(value));

test('with no stored row the reader returns the code defaults and the public GET answers 200', async () => {
  const sqlite = setup();
  try {
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM site_content').get().n, 0);
    const content = await readSiteContent(globalThis.__contentEnv.DB);
    assert.deepEqual(content, DEFAULT_SITE_CONTENT);
    assert.equal(content.hero.line1, '找到自己的價值，');
    assert.equal(content.quickEntries.length, 3);
    const response = await get();
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).content, DEFAULT_SITE_CONTENT);
  } finally { sqlite.close(); }
});

test('a manager can save valid content; it is stored, audited, and read back', async () => {
  const sqlite = setup();
  try {
    as(mgr, managerToken);
    const edited = clone(DEFAULT_SITE_CONTENT);
    edited.tagline = '新的標語';
    edited.faqs = [{ question: '怎麼報名？', answer: '請從近期活動點選報名。' }];
    edited.hero.emphasis = ['社群'];
    const saved = await put(edited);
    assert.equal(saved.status, 200);
    const row = sqlite.prepare('SELECT content, updated_by AS by FROM site_content WHERE id=1').get();
    assert.equal(row.by, 'mgr');
    assert.deepEqual(JSON.parse(row.content), edited);
    const audit = sqlite.prepare("SELECT actor_id AS actor, entity_type AS entityType, entity_id AS entityId FROM audit_logs WHERE action='update_site_content'").all().map(r => ({ ...r }));
    assert.deepEqual(audit, [{ actor: 'mgr', entityType: 'site_content', entityId: '1' }]);
    as(mgr, managerToken);
    const managed = await get('?scope=manage');
    assert.equal(managed.status, 200);
    assert.equal((await managed.json()).content.tagline, '新的標語');
    assert.deepEqual(await readSiteContent(globalThis.__contentEnv.DB), edited);
    // A second save updates the single row instead of adding one.
    edited.tagline = '第二次';
    assert.equal((await put(edited)).status, 200);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM site_content').get().n, 1);
    assert.equal((await readSiteContent(globalThis.__contentEnv.DB)).tagline, '第二次');
  } finally { sqlite.close(); }
});

test('a member gets 403 for the manage read and for writes, and nothing is stored', async () => {
  const sqlite = setup();
  try {
    as(mem, memberToken);
    assert.equal((await put(clone(DEFAULT_SITE_CONTENT))).status, 403);
    assert.equal((await get('?scope=manage')).status, 403);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM site_content').get().n, 0);
    assert.equal((await get()).status, 200, 'the public read stays open');
  } finally { sqlite.close(); }
});

test('a request from another origin is rejected before anything is written', async () => {
  const sqlite = setup();
  try {
    as(mgr, managerToken);
    assert.equal((await put(clone(DEFAULT_SITE_CONTENT), 'https://evil.example')).status, 403);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM site_content').get().n, 0);
  } finally { sqlite.close(); }
});

test('invalid shapes and oversized text are rejected with 400 and nothing is stored', async () => {
  const sqlite = setup();
  try {
    as(mgr, managerToken);
    const tooManyFaqs = clone(DEFAULT_SITE_CONTENT);
    tooManyFaqs.faqs = Array.from({ length: SITE_CONTENT_LIMITS.faqs.count + 1 }, (_, i) => ({ question: `Q${i}`, answer: 'A' }));
    const tooLong = clone(DEFAULT_SITE_CONTENT);
    tooLong.hero.line1 = 'x'.repeat(SITE_CONTENT_LIMITS.heroLine + 1);
    const badAnswer = clone(DEFAULT_SITE_CONTENT);
    badAnswer.faqs[0].answer = 'y'.repeat(SITE_CONTENT_LIMITS.faqs.answer + 1);
    const notArray = clone(DEFAULT_SITE_CONTENT);
    notArray.quickEntries = 'nope';
    const missingSection = clone(DEFAULT_SITE_CONTENT);
    delete missingSection.sections.news;
    const blankTitle = clone(DEFAULT_SITE_CONTENT);
    blankTitle.benefits[1].title = '   ';
    for (const [label, body, field] of [
      ['too many FAQ items', tooManyFaqs, 'faqs'],
      ['hero line too long', tooLong, 'hero.line1'],
      ['FAQ answer too long', badAnswer, 'faqs[0].answer'],
      ['quick entries not an array', notArray, 'quickEntries'],
      ['missing section', missingSection, 'sections.news'],
      ['blank benefit title', blankTitle, 'benefits[1].title'],
      ['not an object', null, 'hero'],
    ]) {
      const response = await put(body);
      assert.equal(response.status, 400, label);
      const json = await response.json();
      assert.ok(json.fields.some(item => item.includes(field)), `${label}: ${JSON.stringify(json.fields)}`);
    }
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM site_content').get().n, 0);
  } finally { sqlite.close(); }
});

test('the public reader merges stored JSON onto defaults and ignores bad fields', async () => {
  const sqlite = setup();
  try {
    const stored = {
      tagline: '自訂標語',
      hero: { line1: 'A' },
      quickEntries: [{ title: 'T1', text: 'x1' }, { title: 'T2', text: 'x2' }, { title: 'T3', text: 'x3' }, { title: 'T4', text: 'x4' }],
      faqs: [{ question: 'Q1', answer: 'A1' }],
      footer: { text: 'z'.repeat(SITE_CONTENT_LIMITS.footer + 1) },
    };
    sqlite.prepare('INSERT INTO site_content(id,content,updated_at,updated_by) VALUES(1,?,?,?)').run(JSON.stringify(stored), '2026', 'mgr');
    const merged = await readSiteContent(globalThis.__contentEnv.DB);
    assert.equal(merged.tagline, '自訂標語');
    assert.equal(merged.hero.line1, 'A', 'a valid stored field wins');
    assert.equal(merged.hero.line2, DEFAULT_SITE_CONTENT.hero.line2, 'a missing field keeps its default');
    assert.deepEqual(merged.hero.emphasis, DEFAULT_SITE_CONTENT.hero.emphasis);
    assert.deepEqual(merged.faqs, [{ question: 'Q1', answer: 'A1' }]);
    assert.equal(merged.quickEntries.length, 3, 'lists are capped at their limit');
    assert.equal(merged.quickEntries[2].title, 'T3');
    assert.equal(merged.footer.text, DEFAULT_SITE_CONTENT.footer.text, 'an over-long field falls back to the default');
    assert.deepEqual(Object.keys(merged).sort(), Object.keys(DEFAULT_SITE_CONTENT).sort());

    sqlite.prepare("UPDATE site_content SET content='[1,2]' WHERE id=1").run();
    assert.deepEqual(await readSiteContent(globalThis.__contentEnv.DB), DEFAULT_SITE_CONTENT, 'a stored value that is not an object gives the defaults');
    assert.deepEqual(buildSiteContent(null).content, DEFAULT_SITE_CONTENT);
  } finally { sqlite.close(); }
});
