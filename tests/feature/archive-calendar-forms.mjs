import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import net from 'node:net';

// This test only boots a copied build with a fresh local D1 directory.
const args = Object.fromEntries(process.argv.slice(2).map((item) => {
  const split = item.indexOf('=');
  return [item.slice(0, split), item.slice(split + 1)];
}));
const repo = path.resolve(args['--repo'] || process.cwd());
const out = path.resolve(args['--out'] || path.join(repo, '.argo/runtime/ops-gantt-calendar'));
const port = Number(args['--port'] || 8806);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid local port');
await fs.mkdir(out, { recursive: true });
const local = path.join(out, `isolated-${randomUUID()}`);
const dist = path.join(local, 'dist');
const configPath = path.join(local, 'wrangler.json');
const cli = path.join(repo, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const state = path.join(local, 'state');
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: path.join(local, 'wrangler-logs') };
const base = `http://127.0.0.1:${port}`;
const report = { schema: 1, runAt: new Date().toISOString(), origin: base, scope: 'fresh isolated local D1; no production DB or deploy', checks: [], browserErrors: [] };
function check(name, ok, detail = '') {
  report.checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) throw Error(`${name}: ${detail}`);
}
function wrangler(extra) {
  const result = spawnSync(process.execPath, [cli, ...extra, '--config', configPath], { cwd: local, env, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw Error('Local wrangler operation failed: ' + result.stderr.slice(-1500));
}
let server;
let browser;
try {
  await fs.mkdir(local);
  await fs.cp(path.join(repo, 'dist'), dist, { recursive: true });
  const source = JSON.parse(await fs.readFile(path.join(dist, 'server', 'wrangler.json'), 'utf8'));
  const config = {
    name: 'puzzle-ops-feature-local',
    main: './dist/server/' + source.main,
    compatibility_date: source.compatibility_date,
    compatibility_flags: source.compatibility_flags,
    no_bundle: true,
    rules: source.rules,
    assets: { directory: './dist/client' },
    d1_databases: [{ binding: 'DB', database_name: 'ops-feature-local', database_id: '00000000-0000-4000-8000-000000000000' }],
    vars: { INITIAL_ADMIN_PASSWORD: 'Regression-Local-Only-2026' },
  };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(Error('Refusing occupied local port')));
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
  const migrations = (await fs.readdir(path.join(repo, 'drizzle'))).filter((file) => file.endsWith('.sql')).sort();
  for (const file of migrations) wrangler(['d1', 'execute', 'DB', '--local', '--persist-to', state, '--file', path.join(repo, 'drizzle', file)]);
  const log = await fs.open(path.join(local, 'server.log'), 'w');
  server = spawn(process.execPath, [cli, 'dev', '--config', configPath, '--local', '--persist-to', state, '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0'], { cwd: local, env, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
  for (let attempt = 0; attempt < 90; attempt++) {
    if (server.exitCode !== null) throw Error('Local server exited during startup');
    try { if ((await fetch(base)).status === 200) break; } catch { /* retry local startup */ }
    if (attempt === 89) throw Error('Local server startup timeout');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const playwrightPath = args['--playwright'] || process.env.REGRESSION_PLAYWRIGHT || path.join(process.env.USERPROFILE || process.env.HOME || '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
  const { chromium } = await import(pathToFileURL(playwrightPath));
  browser = await chromium.launch({ headless: true, ...(args['--browser'] || process.env.REGRESSION_BROWSER ? { executablePath: args['--browser'] || process.env.REGRESSION_BROWSER } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
  async function context() {
    const result = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei', colorScheme: 'light', reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 } });
    await result.addInitScript(() => {
      const NativeDate = Date;
      class FixedDate extends NativeDate {
        constructor(...parts) { super(...(parts.length ? parts : ['2026-09-23T12:00:00.000Z'])); }
        static now() { return NativeDate.parse('2026-09-23T12:00:00.000Z'); }
      }
      window.Date = FixedDate;
    });
    return result;
  }
  const admin = await context();
  const manager = await context();
  const member = await context();
  const coordinator = await context();
  const api = (client, url, method = 'GET', data) => client.request.fetch(base + url, { method, data, headers: { Origin: base } });
  async function expectStatus(name, client, url, expected, method = 'GET', data) {
    let response = await api(client, url, method, data);
    // Retry only Wrangler's transient local worker-restart response. Submission
    // retries retain their idempotency key; application errors are never retried.
    for (let retry = 0; retry < 2 && response.status() === 503 && (await response.text()).includes('worker restarted mid-request'); retry++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      response = await api(client, url, method, data);
    }
    check(name, response.status() === expected, `HTTP ${response.status()}, expected ${expected}: ${response.status() === expected ? '' : (await response.text()).slice(0, 300)}`);
    return response;
  }
  async function workspace() { return (await (await api(admin, '/api/workspace')).json()); }
  async function mutate(name, action, change) {
    const before = await workspace();
    const next = change(before.state);
    await expectStatus(name, admin, '/api/workspace', 200, 'PUT', { state: next, version: before.version, action });
    return next;
  }
  async function login(client, username) {
    await expectStatus(`${username} login`, client, '/api/auth/login', 200, 'POST', { username, password: 'Regression-Local-Only-2026' });
  }
  async function open(page, label) {
    await page.getByRole('navigation', { name: '主要導覽', exact: true }).getByRole('button', { name: label, exact: true }).click();
    await page.getByRole('heading', { name: label, exact: true, level: 1 }).waitFor();
  }
  function observe(page, role) {
    page.on('pageerror', (error) => report.browserErrors.push({ role, type: 'pageerror', message: error.message }));
    page.on('console', (message) => { if (message.type() === 'error') report.browserErrors.push({ role, type: 'console', message: message.text() }); });
  }

  await login(admin, 'kao19950411');
  const traineeReply = await expectStatus('Create trainee', admin, '/api/members', 201, 'POST', { username: 'feature.trainee', displayName: 'Feature Trainee', role: 'trainee_coordinator', password: 'Regression-Local-Only-2026' });
  const traineeId = (await traineeReply.json()).member.id;
  await expectStatus('Create member', admin, '/api/members', 201, 'POST', { username: 'feature.member', displayName: 'Feature Member', role: 'member', password: 'Regression-Local-Only-2026' });
  await expectStatus('Create general manager', admin, '/api/members', 201, 'POST', { username: 'feature.manager', displayName: 'Feature Manager', role: 'manager', password: 'Regression-Local-Only-2026' });
  await login(member, 'feature.member');
  await login(manager, 'feature.manager');
  const trainee = await context();
  await login(trainee, 'feature.trainee');
  const active = { id: 'active-event', name: 'Active Future Event', date: '2026-12-10', startDate: '2026-10-15', endDate: '2026-12-24', status: '籌備中', owner: '嘉駿', description: 'Preserve original description' };
  const ended = { id: 'ended-event', name: 'Archived Event', date: '2026-08-01', endDate: '2026-08-15', status: '已結束', owner: '嘉駿', description: 'Historical record must persist' };
  const settling = { id: 'settling-event', name: 'Settlement In Progress', date: '2026-09-22', endDate: '2026-10-10', status: '執行中', owner: '嘉駿', description: 'Event date alone must not hide' };
  for (const row of [active, ended, settling]) await mutate(`Create ${row.id}`, 'create_activity', (s) => ({ ...s, activities: [...s.activities, row] }));
  await mutate('Assign trainee own activity', 'assign_activity_authority', (s) => ({ ...s, activities: s.activities.map((a) => a.id === active.id ? { ...a, traineeCoordinatorId: traineeId } : a) }));
  const task = { id: 'phase-task', name: 'Active Week Task', activityId: active.id, phaseId: 'P7', assignee: 'Feature Member', startDate: '2026-11-26', due: '2026-12-10', status: '待處理', blocker: '' };
  await mutate('Create task at phase week limit', 'create_task', (s) => ({ ...s, tasks: [...s.tasks, task] }));
  await mutate('Create completed task', 'create_task', (s) => ({ ...s, tasks: [...s.tasks, { ...task, id: 'done-task', phaseId: 'P8', name: 'Archived Completed Task', status: '完成' }] }));
  await mutate('Create task from ended event', 'create_task', (s) => ({ ...s, tasks: [...s.tasks, { ...task, id: 'ended-task', name: 'Archived Event Task', activityId: ended.id, phaseId: 'P9', startDate: '2026-08-08', due: '2026-08-15' }] }));
  const meeting = { id: 'active-meeting', title: 'Active Future Meeting', activityId: active.id, time: '2026-12-01T10:00', endTime: '2026-12-01T11:00', status: '已確認', organizer: '嘉駿', recorder: 'Feature Member', attendees: ['嘉駿', 'Feature Member'] };
  await mutate('Create active meeting', 'create_meeting', (s) => ({ ...s, meetings: [...s.meetings, meeting] }));
  await mutate('Create ended meeting', 'create_meeting', (s) => ({ ...s, meetings: [...s.meetings, { ...meeting, id: 'ended-meeting', title: 'Archived Meeting', time: '2026-08-01T10:00', endTime: '2026-08-01T11:00', status: '已結束' }] }));

  async function taskChange(client, name, patch, expected = 200, action = 'edit_task') {
    const before = await workspace();
    const next = { ...before.state, tasks: before.state.tasks.map((t) => t.id === task.id ? { ...t, ...patch } : t) };
    if (action === 'reschedule') next.notices = [{ id: randomUUID(), title: '改期', detail: 'Feature regression', createdAt: new Date().toISOString(), read: false }, ...next.notices];
    await expectStatus(name, client, '/api/workspace', expected, 'PUT', { state: next, version: before.version, action });
  }
  await taskChange(trainee, 'Trainee sets own authorized Deadline earlier', { due: '2026-12-08', manualDue: true });
  await taskChange(trainee, 'Trainee cannot defer beyond phase week', { due: '2026-12-11' }, 400);
  await taskChange(admin, 'System admin cannot bypass phase task upper limit', { due: '2026-12-11' }, 400);
  await taskChange(manager, 'General manager cannot bypass phase upper limit', { due: '2026-12-11' }, 400);
  await taskChange(member, 'Member may bring own task forward', { due: '2026-12-07' });
  await taskChange(member, 'Member drag reschedule above upper limit rejected', { due: '2026-12-12' }, 400, 'reschedule');
  await taskChange(member, 'Member manual reschedule earlier accepted', { due: '2026-12-06' }, 200, 'reschedule');
  await taskChange(admin, 'Impossible calendar date rejected', { due: '2026-02-30' }, 400);
  const beforeCreate = await workspace();
  await expectStatus('Create task beyond its P1 week rejected', admin, '/api/workspace', 400, 'PUT', { state: { ...beforeCreate.state, tasks: [...beforeCreate.state.tasks, { ...task, id: 'overdue-new', phaseId: 'P1' }] }, version: beforeCreate.version, action: 'create_task' });
  await expectStatus('New activity task cannot omit phase to bypass deadline', admin, '/api/workspace', 400, 'PUT', { state: { ...beforeCreate.state, tasks: [...beforeCreate.state.tasks, { ...task, id: 'unphased-new', phaseId: '' }] }, version: beforeCreate.version, action: 'create_task' });
  await taskChange(trainee, 'Removing phase cannot bypass weekly deadline', { phaseId: '', due: '2026-12-12' }, 400);
  const beforeUnowned = await workspace();
  await expectStatus('Trainee cannot set unowned activity task deadline', trainee, '/api/workspace', 403, 'PUT', { state: { ...beforeUnowned.state, tasks: beforeUnowned.state.tasks.map((t) => t.id === 'ended-task' ? { ...t, due: '2026-08-14' } : t) }, version: beforeUnowned.version, action: 'edit_task' });
  await mutate('Manager can tighten phase due with valid tasks', 'edit_phase', (s) => ({ ...s, activities: s.activities.map((a) => a.id === active.id ? { ...a, phasePlans: { P7: { due: '2026-12-07' } } } : a) }));
  await taskChange(admin, 'Tighter configured phase due enforced', { due: '2026-12-08' }, 400);
  const beforePhase = await workspace();
  await expectStatus('Phase tightening cannot strand task past deadline', admin, '/api/workspace', 400, 'PUT', { state: { ...beforePhase.state, activities: beforePhase.state.activities.map((a) => a.id === active.id ? { ...a, phasePlans: { P7: { due: '2026-12-01' } } } : a) }, version: beforePhase.version, action: 'edit_phase' });
  const beforeEvent = await workspace();
  await expectStatus('Activity move cannot strand task past new week limit', admin, '/api/workspace', 400, 'PUT', { state: { ...beforeEvent.state, activities: beforeEvent.state.activities.map((a) => a.id === active.id ? { ...a, date: '2026-11-01' } : a) }, version: beforeEvent.version, action: 'edit_activity' });
  await expectStatus('Invalid activity date cannot remove week limit', admin, '/api/workspace', 400, 'PUT', { state: { ...beforeEvent.state, activities: beforeEvent.state.activities.map((a) => a.id === active.id ? { ...a, date: 'invalid' } : a) }, version: beforeEvent.version, action: 'edit_activity' });

  const adminPage = await admin.newPage();
  observe(adminPage, 'admin');
  await adminPage.goto(base);
  await adminPage.getByRole('heading', { name: '營運總覽', exact: true }).waitFor();
  async function assertHistory(page, label, hiddenText, activeText) {
    await open(page, label);
    check(`${label} active item remains visible`, await page.getByText(activeText, { exact: true }).first().isVisible());
    check(`${label} historical item defaults hidden`, await page.getByText(hiddenText, { exact: true }).count() === 0);
    const toggle = page.getByRole('checkbox', { name: /顯示已/ });
    await toggle.check();
    check(`${label} manager history reveals without deletion`, await page.getByText(hiddenText, { exact: true }).first().isVisible());
    await toggle.uncheck();
  }
  await assertHistory(adminPage, '活動管理', ended.name, active.name);
  check('Post-event settlement activity remains visible', await adminPage.getByText(settling.name, { exact: true }).first().isVisible());
  await assertHistory(adminPage, '任務中心', 'Archived Completed Task', task.name);
  check('Ended activity tasks default hidden', await adminPage.getByText('Archived Event Task', { exact: true }).count() === 0);
  await assertHistory(adminPage, '會議協調', 'Archived Meeting', meeting.title);
  const memberPage = await member.newPage();
  observe(memberPage, 'member');
  await memberPage.goto(base);
  await memberPage.getByRole('heading', { name: '營運總覽', exact: true }).waitFor();
  for (const label of ['活動管理', '任務中心', '會議協調', '行事曆']) {
    await open(memberPage, label);
    check(`${label} ordinary member has no history control`, await memberPage.getByRole('checkbox', { name: /顯示已/ }).count() === 0);
  }
  await open(adminPage, '行事曆');
  await adminPage.getByLabel('行事曆視角').selectOption('all');
  for (let month = 0; month < 3; month++) await adminPage.getByRole('button', { name: '下一個月', exact: true }).click();
  check('Responsive calendar exercises populated task and meeting month', await adminPage.locator('.calendar-day[aria-label="2026-12-06，1 個項目"]').count() === 1 && await adminPage.locator('.calendar-day[aria-label="2026-12-01，1 個項目"]').count() === 1);
  for (const width of [320, 375, 390, 768, 1440]) {
    await adminPage.setViewportSize({ width, height: 900 });
    const fit = await adminPage.evaluate(() => {
      const grid = document.querySelector('.calendar-grid');
      const scroll = document.querySelector('.calendar-grid-scroll');
      return grid && scroll && grid.scrollWidth <= scroll.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1 && getComputedStyle(grid).gridTemplateColumns.split(' ').length === 7;
    });
    check(`Month grid fits all seven columns at ${width}px`, fit);
    await adminPage.screenshot({ path: path.join(out, `calendar-${width}.png`) });
  }
  await adminPage.setViewportSize({ width: 1440, height: 1000 });
  const taskEntry = adminPage.getByRole('button', { name: 'Active Week Task', exact: true });
  await taskEntry.dragTo(adminPage.locator('.calendar-day[aria-label^="2026-12-20"]'));
  check('UI drag past week cap keeps original deadline', (await workspace()).state.tasks.find((t) => t.id === task.id).due === '2026-12-06');
  let confirmation = false;
  adminPage.once('dialog', async (dialog) => { confirmation = true; await dialog.dismiss(); });
  await taskEntry.dragTo(adminPage.locator('.calendar-day[aria-label^="2026-12-05"]'));
  check('Valid drag still asks confirmation and cancellation preserves date', confirmation && (await workspace()).state.tasks.find((t) => t.id === task.id).due === '2026-12-06');
  const persisted = await workspace();
  check('All historical records remain in saved workspace', persisted.state.activities.some((a) => a.id === ended.id && a.description === ended.description) && persisted.state.tasks.some((t) => t.id === 'done-task') && persisted.state.meetings.some((m) => m.id === 'ended-meeting'));
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1kAAAAASUVORK5CYII=';
  const article = '活動詳細介紹\n\n' + '這是活動說明與資料使用方式。'.repeat(420);
  const privacy = '個資告知第一段\n第二段：用途、保留期間與聯絡窗口。';
  const form = { id: 'image-form', activityId: active.id, title: 'Image Article Form', description: article, image: png, privacyNotice: privacy, owner: '嘉駿', status: 'open', createdAt: new Date().toISOString(), fields: [{ id: 'visitor-name', label: '參加者名稱', type: 'short_text', required: true, sensitive: true, helpText: '題目詳細文章\n另一段說明', image: png }] };
  let saved = (await (await expectStatus('Save image and long article form', admin, '/api/registration-forms', 200, 'POST', { form })).json()).form;
  check('Stored form and question images plus long article preserved', saved.image === png && saved.fields[0].image === png && saved.description === article && saved.privacyNotice === privacy);
  const reloaded = (await (await expectStatus('Reload saved form', admin, `/api/registration-forms?activityId=${active.id}`, 200)).json()).forms[0];
  check('Presentation survives separate request', reloaded.image === png && reloaded.fields[0].helpText === form.fields[0].helpText && reloaded.description.length > 5000);
  const anonymous = await context();
  const publicJson = (await (await expectStatus('Anonymous public form read', anonymous, `/api/public/registrations/${saved.slug}`, 200)).json()).form;
  check('Anonymous API provides theme and question images and article', publicJson.image === png && publicJson.fields[0].image === png && publicJson.description === article);
  await expectStatus('SVG image rejected', admin, '/api/registration-forms', 400, 'POST', { form: { ...saved, image: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } });
  await expectStatus('Remote image URL rejected', admin, '/api/registration-forms', 400, 'POST', { form: { ...saved, image: 'https://example.com/image.png' } });
  await expectStatus('Wrong raster MIME rejected', admin, '/api/registration-forms', 400, 'POST', { form: { ...saved, image: png.replace('image/png', 'image/jpeg') } });
  const fakeBytes = Buffer.alloc(256 * 1024 + 1); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(fakeBytes);
  await expectStatus('Single oversized image rejected', admin, '/api/registration-forms', 400, 'POST', { form: { ...saved, image: 'data:image/png;base64,' + fakeBytes.toString('base64') } });
  await expectStatus('Long article has bounded maximum', admin, '/api/registration-forms', 400, 'POST', { form: { ...saved, description: '文'.repeat(20001) } });
  await expectStatus('Question article has bounded maximum', admin, '/api/registration-forms', 400, 'POST', { form: { ...saved, fields: [{ ...saved.fields[0], helpText: '文'.repeat(10001) }] } });
  await expectStatus('Multibyte request size bounded by bytes', admin, '/api/registration-forms', 413, 'POST', { form: { ...saved, description: '文'.repeat(700000) } });
  await expectStatus('Member cannot change form images', member, '/api/registration-forms', 403, 'POST', { form: saved });
  await expectStatus('Anonymous valid submission preserved', anonymous, `/api/public/registrations/${saved.slug}`, 201, 'POST', { answers: { 'visitor-name': 'Local Regression Visitor' }, consent: true, idempotencyKey: randomUUID() });
  await expectStatus('Trainee still cannot export private responses', trainee, '/api/registration-forms', 403, 'PUT', { formId: saved.id });
  await expectStatus('After responses presentation edits allowed', admin, '/api/registration-forms', 200, 'POST', { form: { ...saved, description: article + '\n補充段落', fields: [{ ...saved.fields[0], helpText: '更新說明\n仍保留原回答', image: undefined }] } });
  await expectStatus('After responses answer type still locked', admin, '/api/registration-forms', 409, 'POST', { form: { ...saved, fields: [{ ...saved.fields[0], type: 'long_text' }] } });
  const publicPage = await anonymous.newPage();
  observe(publicPage, 'public');
  await publicPage.goto(base + '/r/' + saved.slug);
  await publicPage.getByRole('heading', { name: form.title, exact: true }).waitFor();
  check('Public theme image rendered', await publicPage.getByRole('img').count() === 1);
  check('Public article preserves paragraphs', await publicPage.getByText(article + '\n補充段落', { exact: true }).evaluate((el) => getComputedStyle(el).whiteSpace === 'pre-wrap'));
  check('Public privacy notice preserves paragraphs', await publicPage.getByText(privacy, { exact: true }).evaluate((el) => getComputedStyle(el).whiteSpace === 'pre-wrap'));
  await publicPage.setViewportSize({ width: 375, height: 844 });
  check('Public long article and image fit mobile', await publicPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await publicPage.screenshot({ path: path.join(out, 'public-image-mobile.png') });
  await open(adminPage, '活動管理');
  await adminPage.getByRole('button', { name: /報名表/ }).first().click();
  await adminPage.getByRole('button', { name: '編輯問題', exact: true }).click();
  const editor = adminPage.getByRole('dialog', { name: '編輯報名表', exact: true });
  await editor.getByLabel('主題圖片', { exact: true }).setInputFiles({ name: 'local.png', mimeType: 'image/png', buffer: Buffer.from(png.split(',')[1], 'base64') });
  await editor.getByLabel('問題圖片', { exact: true }).setInputFiles({ name: 'question.png', mimeType: 'image/png', buffer: Buffer.from(png.split(',')[1], 'base64') });
  await editor.locator('.registration-builder-help textarea').fill('經 UI 修改的詳細說明\n第二段');
  await editor.getByRole('img').nth(1).waitFor();
  await editor.getByRole('button', { name: '儲存報名表', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  saved = (await (await api(admin, `/api/registration-forms?activityId=${active.id}`)).json()).forms[0];
  check('Actual file uploads and article editor persist', saved.image.startsWith('data:image/png;base64,') && saved.fields[0].image.startsWith('data:image/png;base64,') && saved.fields[0].helpText === '經 UI 修改的詳細說明\n第二段');
  await publicPage.reload();
  await publicPage.getByRole('img').nth(1).waitFor();
  check('Public page renders both uploaded images after reload', await publicPage.getByRole('img').count() === 2);
  await publicPage.screenshot({ path: path.join(out, 'public-images-after-upload.png') });
  await mutate('Lock trainee submitted activity', 'submit_activity', (s) => ({ ...s, activities: s.activities.map((a) => a.id === active.id ? { ...a, settingsSubmittedAt: new Date().toISOString() } : a) }));
  await taskChange(trainee, 'Submitted activity still locks trainee deadline changes', { due: '2026-12-05' }, 403);
  await taskChange(admin, 'Manager may revise valid deadline after submission', { due: '2026-12-05' });
  check('No browser runtime errors', report.browserErrors.length === 0, JSON.stringify(report.browserErrors));
} catch (error) {
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    else server.kill();
  }
  report.passed = !report.failure && report.checks.every((item) => item.ok);
  if (!report.passed) process.exitCode = 1;
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, out, failure: report.failure }));
}
