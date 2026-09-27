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
    const response = await api(client, url, method, data);
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
  await expectStatus('Create manager fixture', admin, '/api/members', 201, 'POST', { username: 'ops.manager', displayName: 'Ops Manager', role: 'manager', password: 'Regression-Local-Only-2026' });
  const coordinatorResponse = await expectStatus('Create coordinator fixture', admin, '/api/members', 201, 'POST', { username: 'ops.coordinator', displayName: 'Ops Coordinator', role: 'coordinator', password: 'Regression-Local-Only-2026' });
  const coordinatorId = (await coordinatorResponse.json()).member.id;
  const traineeResponse = await expectStatus('Create trainee coordinator fixture', admin, '/api/members', 201, 'POST', { username: 'ops.trainee', displayName: 'Ops Trainee', role: 'trainee_coordinator', password: 'Regression-Local-Only-2026' });
  const traineeId = (await traineeResponse.json()).member.id;
  await expectStatus('Create member fixture', admin, '/api/members', 201, 'POST', { username: 'ops.member', displayName: 'Ops Member', role: 'member', password: 'Regression-Local-Only-2026' });
  await login(manager, 'ops.manager');
  await login(coordinator, 'ops.coordinator');
  await login(member, 'ops.member');
  const trainee = await context();
  await login(trainee, 'ops.trainee');
  const rejectedResponse = await expectStatus('Create rejected application fixture', admin, '/api/members', 201, 'POST', { username: 'ops.rejected', displayName: 'Ops Rejected', role: 'member', status: 'rejected', password: 'Regression-Local-Only-2026' });
  const rejectedId = (await rejectedResponse.json()).member.id;
  const activeResponse = await expectStatus('Create active deletion guard fixture', admin, '/api/members', 201, 'POST', { username: 'ops.active', displayName: 'Ops Active', role: 'member', password: 'Regression-Local-Only-2026' });
  const activeId = (await activeResponse.json()).member.id;
  await expectStatus('Admin deletes rejected applicant', admin, '/api/members', 200, 'POST', { action: 'delete_rejected', id: rejectedId });
  check('Rejected applicant deletion persists', !(await (await api(admin, '/api/members')).json()).members.some((row) => row.id === rejectedId));

  const activity = {
    id: 'ops-activity', name: 'Ops Activity', date: '2026-10-01', owner: '嘉駿', status: '籌備中', description: 'Before edit',
    startDate: '2026-08-06', endDate: '2026-10-15', proxy: 'Ops Member', location: 'Before venue', teams: ['企劃'],
    progress: 0, budget: 1000, type: '工作坊', size: '中型', targetAttendance: 50, currentMilestone: 'Before milestone',
  };
  const otherActivity = { id: 'other-activity', name: 'Other Activity', date: '2026-10-02', owner: 'Ops Coordinator', status: '規劃中', description: 'Other' };
  await mutate('Seed own activity', 'create_activity', (current) => ({ ...current, activities: [...current.activities, activity] }));
  await mutate('Seed other activity', 'create_activity', (current) => ({ ...current, activities: [...current.activities, otherActivity] }));
  const task = {
    id: 'ops-task', name: 'Ops Task', activityId: activity.id, assignee: '嘉駿', due: '2026-09-23', startDate: '2026-09-16',
    status: '待處理', blocker: '', proxy: 'Ops Member', collaborators: ['Ops Manager'], phaseId: 'P7', priority: '一般', progressPercent: 20,
  };
  const otherTask = { id: 'other-task', name: 'Other Task', activityId: otherActivity.id, assignee: 'Ops Member', due: '2026-09-23', startDate: '2026-09-20', status: '待處理', blocker: '' };
  const coordinatorTask = { id: 'coordinator-task', name: 'Coordinator Task', activityId: otherActivity.id, assignee: 'Ops Coordinator', due: '2026-09-23', startDate: '2026-09-20', status: '待處理', blocker: '' };
  const alignedTask = { id: 'aligned-task', name: 'Aligned Task', activityId: activity.id, assignee: 'Ops Manager', due: '2026-10-01', startDate: '2026-09-17', status: '待處理', blocker: '', phaseId: 'P7' };
  await mutate('Seed own task', 'create_task', (current) => ({ ...current, tasks: [...current.tasks, task] }));
  await mutate('Seed other task', 'create_task', (current) => ({ ...current, tasks: [...current.tasks, otherTask] }));
  await mutate('Seed coordinator task', 'create_task', (current) => ({ ...current, tasks: [...current.tasks, coordinatorTask] }));
  await mutate('Seed auto-aligned task', 'create_task', (current) => ({ ...current, tasks: [...current.tasks, alignedTask] }));
  const meeting = {
    id: 'ops-meeting', title: 'Ops Meeting', activityId: activity.id, time: '2026-09-23T09:00:00+08:00',
    endTime: '2026-09-23T10:00:00+08:00', status: '待確認', type: '工作會議', organizer: '嘉駿', recorder: 'Ops Member',
    attendees: ['嘉駿', 'Ops Member'], attendeeResponses: [{ name: '嘉駿', response: '待回覆' }, { name: 'Ops Member', response: '待回覆' }],
    location: 'Before room', meetingLink: '', agenda: 'Before agenda', attending: 0, total: 2,
  };
  await mutate('Seed meeting', 'create_meeting', (current) => ({ ...current, meetings: [...current.meetings, meeting] }));

  const adminPage = await admin.newPage();
  observe(adminPage, 'admin');
  await adminPage.goto(base);
  await adminPage.getByRole('heading', { name: '營運總覽', exact: true }).waitFor();
  await adminPage.locator('.sync').filter({ hasText: '已同步' }).waitFor();
  await open(adminPage, '成員管理');
  const coordinatorRow = adminPage.locator('.members-table-wrap tr').filter({ hasText: '@ops.coordinator' });
  await coordinatorRow.getByRole('button', { name: '設定活動職權' }).click();
  const coordinatorGrantDialog = adminPage.getByRole('dialog', { name: '設定 Ops Coordinator 的活動職權' });
  await coordinatorGrantDialog.screenshot({ path: path.join(out, 'member-authority-desktop.png') });
  await adminPage.setViewportSize({ width: 390, height: 844 });
  check('Member authority dialog fits mobile viewport', await adminPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await coordinatorGrantDialog.screenshot({ path: path.join(out, 'member-authority-mobile.png') });
  await adminPage.setViewportSize({ width: 1440, height: 1000 });
  await coordinatorGrantDialog.getByRole('checkbox', { name: 'Other Activity' }).check();
  await coordinatorGrantDialog.getByRole('button', { name: '儲存活動職權' }).click();
  await coordinatorGrantDialog.waitFor({ state: 'hidden' });
  const traineeRow = adminPage.locator('.members-table-wrap tr').filter({ hasText: '@ops.trainee' });
  await traineeRow.getByRole('button', { name: '設定活動職權' }).click();
  const traineeGrantDialog = adminPage.getByRole('dialog', { name: '設定 Ops Trainee 的活動職權' });
  await traineeGrantDialog.getByLabel('獲授權活動').selectOption(otherActivity.id);
  await traineeGrantDialog.getByRole('button', { name: '儲存活動職權' }).click();
  await traineeGrantDialog.waitFor({ state: 'hidden' });
  const assignedActivity = (await workspace()).state.activities.find((row) => row.id === otherActivity.id);
  check('Member management grants persist without changing activity details', assignedActivity?.coordinatorIds?.includes(coordinatorId) && assignedActivity?.traineeCoordinatorId === traineeId && assignedActivity?.description === 'Other');
  const grantBaseline = await workspace();
  const mixedGrant = { ...grantBaseline.state, activities: grantBaseline.state.activities.map((row) => row.id === activity.id ? { ...row, coordinatorIds: [coordinatorId], description: 'Unexpected edit' } : row) };
  await expectStatus('Authority action cannot change business details', admin, '/api/workspace', 403, 'PUT', { state: mixedGrant, version: grantBaseline.version, action: 'assign_activity_authority' });
  const forgedGrant = { ...grantBaseline.state, activities: grantBaseline.state.activities.map((row) => row.id === activity.id ? { ...row, coordinatorIds: [coordinatorId] } : row) };
  await expectStatus('Coordinator cannot grant activity authority', coordinator, '/api/workspace', 403, 'PUT', { state: forgedGrant, version: grantBaseline.version, action: 'assign_activity_authority' });
  await expectStatus('Activity edit cannot carry authority changes', admin, '/api/workspace', 403, 'PUT', { state: forgedGrant, version: grantBaseline.version, action: 'edit_activity' });
  await expectStatus('Stale member authority version is rejected', admin, '/api/workspace', 409, 'PUT', { state: forgedGrant, version: grantBaseline.version - 1, action: 'assign_activity_authority' });
  await open(adminPage, '活動管理');
  await adminPage.getByRole('button', { name: '查看活動詳情與甘特圖' }).first().click();
  const activityDialog = adminPage.getByRole('dialog', { name: 'Ops Activity' });
  await activityDialog.waitFor();
  check('Activity detail omits authority and manual weekly milestone', await activityDialog.getByText('獲授權總召').count() === 0 && await activityDialog.getByText('見習總召').count() === 0 && await activityDialog.getByText('本週里程碑').count() === 0);
  check('Gantt shows default weekly plan without creating phase tasks', await activityDialog.getByText('P1', { exact: true }).count() > 0 && await activityDialog.getByText('目標、對象、預算與活動日期').count() > 0);
  check('Gantt does not create workspace tasks', (await workspace()).state.tasks.length === 4);
  await activityDialog.getByRole('button', { name: '編輯 P1 階段' }).click();
  const phaseDialog = adminPage.getByRole('dialog', { name: '編輯 P1 階段' });
  check('P1 default date derived eight weeks before event', await phaseDialog.locator('input[name="startDate"]').inputValue() === '2026-08-06');
  await phaseDialog.locator('input[name="due"]').fill('2026-08-15');
  await phaseDialog.locator('input[name="progress"]').fill('45');
  await phaseDialog.locator('select[name="owner"]').selectOption('Ops Coordinator');
  await phaseDialog.locator('select[name="proxy"]').selectOption('Ops Member');
  await phaseDialog.locator('textarea[name="notes"]').fill('Phase plan after edit');
  await phaseDialog.getByRole('button', { name: '儲存階段進度' }).click();
  await phaseDialog.waitFor({ state: 'hidden' });
  const afterPhase = await workspace();
  check('Weekly Gantt overrides and assigned members persist without extra task', afterPhase.state.activities.find((row) => row.id === activity.id)?.phasePlans?.P1?.due === '2026-08-15' && afterPhase.state.activities.find((row) => row.id === activity.id)?.phasePlans?.P1?.progress === 45 && afterPhase.state.activities.find((row) => row.id === activity.id)?.phasePlans?.P1?.notes === 'Phase plan after edit' && afterPhase.state.activities.find((row) => row.id === activity.id)?.phasePlans?.P1?.owner === 'Ops Coordinator' && afterPhase.state.activities.find((row) => row.id === activity.id)?.phasePlans?.P1?.proxy === 'Ops Member' && afterPhase.state.tasks.length === 4);
  const invalidPhase = { ...afterPhase.state, activities: afterPhase.state.activities.map((row) => row.id === activity.id ? { ...row, phasePlans: { ...row.phasePlans, P1: { ...row.phasePlans.P1, owner: 'Unregistered Person' } } } : row) };
  await expectStatus('Gantt phase rejects unknown member', admin, '/api/workspace', 400, 'PUT', { state: invalidPhase, version: afterPhase.version, action: 'edit_phase' });
  await activityDialog.getByRole('button', { name: '編輯活動', exact: true }).click();
  const activityEditDialog = adminPage.getByRole('dialog', { name: '編輯活動：Ops Activity' });
  check('Activity form omits authority and manual milestone controls', await activityEditDialog.locator('[name="coordinatorIds"], [name="traineeCoordinatorId"], [name="currentMilestone"]').count() === 0);
  const desktopControlHeights = await activityEditDialog.locator('.mgmt-activity-form-grid input:not([type="hidden"]), .mgmt-activity-form-grid select').evaluateAll((controls) => controls.map((control) => Math.round(control.getBoundingClientRect().height)));
  check('Activity form controls share one desktop height', new Set(desktopControlHeights).size === 1 && desktopControlHeights[0] === 46);
  await activityEditDialog.screenshot({ path: path.join(out, 'activity-form-desktop.png') });
  await adminPage.setViewportSize({ width: 390, height: 844 });
  const mobileControlHeights = await activityEditDialog.locator('.mgmt-activity-form-grid input:not([type="hidden"]), .mgmt-activity-form-grid select').evaluateAll((controls) => controls.map((control) => Math.round(control.getBoundingClientRect().height)));
  check('Activity form controls share one mobile height without overflow', new Set(mobileControlHeights).size === 1 && mobileControlHeights[0] === 46 && await adminPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await activityEditDialog.screenshot({ path: path.join(out, 'activity-form-mobile.png') });
  await adminPage.setViewportSize({ width: 1440, height: 1000 });
  await activityEditDialog.locator('select[name="owner"]').selectOption('Ops Manager');
  await activityEditDialog.locator('select[name="proxy"]').selectOption('嘉駿');
  await activityEditDialog.locator('input[name="location"]').fill('After venue');
  await activityEditDialog.locator('input[name="startDate"]').fill('2026-08-05');
  await activityEditDialog.locator('input[name="endDate"]').fill('2026-10-16');
  await activityEditDialog.locator('textarea[name="description"]').fill('After edit');
  await activityEditDialog.getByRole('button', { name: '儲存活動變更' }).click();
  await activityEditDialog.waitFor({ state: 'hidden' });
  const afterActivity = await workspace();
  const savedActivity = afterActivity.state.activities.find((row) => row.id === activity.id);
  check('Admin edits activity details without losing Gantt or old milestone data', savedActivity?.owner === 'Ops Manager' && savedActivity?.proxy === '嘉駿' && savedActivity?.location === 'After venue' && savedActivity?.startDate === '2026-08-05' && savedActivity?.endDate === '2026-10-16' && savedActivity?.description === 'After edit' && savedActivity?.phasePlans?.P1?.progress === 45 && savedActivity?.currentMilestone === 'Before milestone');
  const forgedActivity = { ...afterActivity.state, activities: afterActivity.state.activities.map((row) => row.id === activity.id ? { ...row, location: 'Forged venue' } : row) };
  await expectStatus('Member cannot forge activity edit', member, '/api/workspace', 403, 'PUT', { state: forgedActivity, version: afterActivity.version, action: 'edit_activity' });
  await expectStatus('Coordinator cannot edit unassigned activity', coordinator, '/api/workspace', 403, 'PUT', { state: forgedActivity, version: afterActivity.version, action: 'edit_activity' });
  const forgedPhase = { ...afterActivity.state, activities: afterActivity.state.activities.map((row) => row.id === activity.id ? { ...row, phasePlans: { ...row.phasePlans, P1: { ...row.phasePlans.P1, progress: 99 } } } : row) };
  await expectStatus('Member cannot forge Gantt phase edit', member, '/api/workspace', 403, 'PUT', { state: forgedPhase, version: afterActivity.version, action: 'edit_phase' });
  const forgedTask = { ...afterActivity.state, tasks: afterActivity.state.tasks.map((row) => row.id === task.id ? { ...row, assignee: 'Ops Member' } : row) };
  await expectStatus('Member cannot reassign another person task', member, '/api/workspace', 403, 'PUT', { state: forgedTask, version: afterActivity.version, action: 'edit_task' });
  await expectStatus('Coordinator cannot reassign unassigned task', coordinator, '/api/workspace', 403, 'PUT', { state: forgedTask, version: afterActivity.version, action: 'edit_task' });
  const forgedMeeting = { ...afterActivity.state, meetings: afterActivity.state.meetings.map((row) => row.id === meeting.id ? { ...row, agenda: 'Forged agenda' } : row) };
  await expectStatus('Member cannot forge meeting details', member, '/api/workspace', 403, 'PUT', { state: forgedMeeting, version: afterActivity.version, action: 'edit_meeting' });
  await expectStatus('Coordinator cannot edit unassigned meeting', coordinator, '/api/workspace', 403, 'PUT', { state: forgedMeeting, version: afterActivity.version, action: 'edit_meeting' });
  async function managerEdit(name, collection, id, patch, action) {
    const before = await workspace();
    const next = { ...before.state, [collection]: before.state[collection].map((row) => row.id === id ? { ...row, ...patch } : row) };
    await expectStatus(name, manager, '/api/workspace', 200, 'PUT', { state: next, version: before.version, action });
    const saved = (await workspace()).state[collection].find((row) => row.id === id);
    check(`${name} persisted`, Object.entries(patch).every(([key, value]) => JSON.stringify(saved?.[key]) === JSON.stringify(value)));
  }
  await managerEdit('Manager edits activity details', 'activities', activity.id, { budget: 2400, description: 'Manager activity edit' }, 'edit_activity');
  await managerEdit('Manager edits task details', 'tasks', task.id, { priority: '高', acceptanceCriteria: 'Manager task edit' }, 'edit_task');
  await managerEdit('Manager edits meeting details', 'meetings', meeting.id, { location: 'Manager room', agenda: 'Manager meeting edit' }, 'edit_meeting');
  await adminPage.reload();
  await adminPage.locator('.sync').filter({ hasText: '已同步' }).waitFor();
  await open(adminPage, '任務中心');
  await adminPage.locator('tr').filter({ hasText: 'Ops Task' }).getByRole('button', { name: '查看', exact: true }).click();
  const taskDialog = adminPage.getByRole('dialog', { name: 'Ops Task' });
  await taskDialog.getByRole('button', { name: '編輯任務', exact: true }).click();
  const taskEditDialog = adminPage.getByRole('dialog', { name: '編輯任務：Ops Task' });
  await taskEditDialog.locator('input[name="jobRole"]').fill('After role');
  await taskEditDialog.locator('select[name="nextOwner"]').selectOption('Ops Manager');
  await taskEditDialog.locator('input[name="progressPercent"]').fill('65');
  await taskEditDialog.locator('textarea[name="executionSteps"]').fill('Step after edit');
  await taskEditDialog.locator('textarea[name="blocker"]').fill('Blocker after edit');
  await taskEditDialog.getByRole('button', { name: '儲存任務變更' }).click();
  await taskEditDialog.waitFor({ state: 'hidden' });
  const savedTask = (await workspace()).state.tasks.find((row) => row.id === task.id);
  check('Admin task detail edit persists', savedTask?.jobRole === 'After role' && savedTask?.nextOwner === 'Ops Manager' && savedTask?.progressPercent === 65 && savedTask?.executionSteps?.[0] === 'Step after edit' && savedTask?.blocker === 'Blocker after edit' && savedTask?.priority === '高');
  await adminPage.reload();
  await adminPage.locator('.sync').filter({ hasText: '已同步' }).waitFor();
  await open(adminPage, '會議協調');
  await adminPage.locator('.mgmt-meeting-card').filter({ hasText: 'Ops Meeting' }).getByRole('button', { name: '編輯會議' }).click();
  const meetingEditDialog = adminPage.getByRole('dialog', { name: '編輯會議：Ops Meeting' });
  await meetingEditDialog.locator('select[name="recorder"]').selectOption('Ops Manager');
  await meetingEditDialog.locator('input[name="endTime"]').fill('2026-09-23T11:00');
  await meetingEditDialog.locator('input[name="location"]').fill('After room');
  await meetingEditDialog.locator('textarea[name="agenda"]').fill('After agenda');
  await meetingEditDialog.getByRole('button', { name: '儲存會議變更' }).click();
  await meetingEditDialog.waitFor({ state: 'hidden' });
  const savedMeeting = (await workspace()).state.meetings.find((row) => row.id === meeting.id);
  check('Admin meeting detail edit persists', savedMeeting?.recorder === 'Ops Manager' && savedMeeting?.endTime === '2026-09-23T11:00:00+08:00' && savedMeeting?.location === 'After room' && savedMeeting?.agenda === 'After agenda');
  const beforeRsvp = await workspace();
  const memberRsvp = { ...beforeRsvp.state, meetings: beforeRsvp.state.meetings.map((row) => row.id === meeting.id ? { ...row, attendeeResponses: [{ name: '嘉駿', response: '待回覆' }, { name: 'Ops Member', response: '出席' }], attending: 1 } : row) };
  await expectStatus('Invited member can answer own attendance', member, '/api/workspace', 200, 'PUT', { state: memberRsvp, version: beforeRsvp.version, action: 'update_meeting_attendance' });
  const afterMemberRsvp = await workspace();
  check('Own attendance persists', afterMemberRsvp.state.meetings.find((row) => row.id === meeting.id)?.attendeeResponses?.find((person) => person.name === 'Ops Member')?.response === '出席');
  const forgedRsvp = { ...afterMemberRsvp.state, meetings: afterMemberRsvp.state.meetings.map((row) => row.id === meeting.id ? { ...row, attendeeResponses: [{ name: '嘉駿', response: '不出席' }, { name: 'Ops Member', response: '出席' }], attending: 1 } : row) };
  await expectStatus('Member cannot answer another attendee', member, '/api/workspace', 403, 'PUT', { state: forgedRsvp, version: afterMemberRsvp.version, action: 'update_meeting_attendance' });
  await expectStatus('Admin may override attendee answer', admin, '/api/workspace', 200, 'PUT', { state: forgedRsvp, version: afterMemberRsvp.version, action: 'update_meeting_attendance' });
  const afterAdminRsvp = await workspace();
  check('Admin attendance override persists', afterAdminRsvp.state.meetings.find((row) => row.id === meeting.id)?.attendeeResponses?.find((person) => person.name === '嘉駿')?.response === '不出席');

  await adminPage.reload();
  await adminPage.locator('.sync').filter({ hasText: '已同步' }).waitFor();
  await open(adminPage, '行事曆');
  const day = (page, date) => page.locator(`.calendar-day[aria-label^="${date}"]`);
  const dayEntry = (page, date, title) => day(page, date).locator('.calendar-drag-item').filter({ hasText: title });
  check('Admin personal calendar includes own task and meeting', await dayEntry(adminPage, '2026-09-23', 'Ops Task').count() === 1 && await dayEntry(adminPage, '2026-09-23', 'Ops Meeting').count() === 1);
  check('Admin personal calendar hides unrelated tasks', await dayEntry(adminPage, '2026-09-23', 'Other Task').count() === 0 && await dayEntry(adminPage, '2026-09-23', 'Coordinator Task').count() === 0);
  check('Task appears only on deadline, not its entire period', await dayEntry(adminPage, '2026-09-17', 'Ops Task').count() === 0);
  check('Planning span does not repeat activity daily', await dayEntry(adminPage, '2026-09-20', 'Ops Activity').count() === 0 && await dayEntry(adminPage, '2026-10-01', 'Ops Activity').count() === 1);
  const calendarView = adminPage.locator('.calendar-task-view select');
  await calendarView.selectOption('all');
  check('Admin can switch to global calendar', await dayEntry(adminPage, '2026-09-23', 'Other Task').count() === 1 && await dayEntry(adminPage, '2026-09-23', 'Coordinator Task').count() === 1);
  await calendarView.selectOption('Ops Member');
  check('Admin can switch to one person responsibility', await dayEntry(adminPage, '2026-09-23', 'Other Task').count() === 1 && await dayEntry(adminPage, '2026-09-23', 'Coordinator Task').count() === 0);
  await calendarView.selectOption('self');

  const coordinatorPage = await coordinator.newPage();
  observe(coordinatorPage, 'coordinator');
  await coordinatorPage.goto(base);
  await coordinatorPage.getByRole('heading', { name: '營運總覽', exact: true }).waitFor();
  await coordinatorPage.locator('.sync').filter({ hasText: '已同步' }).waitFor();
  await open(coordinatorPage, '行事曆');
  const coordinatorView = coordinatorPage.locator('.calendar-task-view select');
  await coordinatorView.selectOption('all');
  check('Coordinator global calendar stays within assigned activities', await dayEntry(coordinatorPage, '2026-09-23', 'Coordinator Task').count() === 1 && await dayEntry(coordinatorPage, '2026-09-23', 'Other Task').count() === 1 && await dayEntry(coordinatorPage, '2026-09-23', 'Ops Task').count() === 0);
  await coordinatorView.selectOption('Ops Member');
  check('Coordinator can switch to a person within assigned activities', await dayEntry(coordinatorPage, '2026-09-23', 'Other Task').count() === 1 && await dayEntry(coordinatorPage, '2026-09-23', 'Coordinator Task').count() === 0);

  const memberPage = await member.newPage();
  observe(memberPage, 'member');
  await memberPage.goto(base);
  await memberPage.getByRole('heading', { name: '營運總覽', exact: true }).waitFor();
  await memberPage.locator('.sync').filter({ hasText: '已同步' }).waitFor();
  await open(memberPage, '行事曆');
  check('Member personal calendar includes assigned and proxy tasks plus invited meeting', await dayEntry(memberPage, '2026-09-23', 'Other Task').count() === 1 && await dayEntry(memberPage, '2026-09-23', 'Ops Task').count() === 1 && await dayEntry(memberPage, '2026-09-23', 'Ops Meeting').count() === 1);
  check('Member personal calendar hides unrelated task', await dayEntry(memberPage, '2026-09-23', 'Coordinator Task').count() === 0);
  check('Member cannot select global view', await memberPage.locator('.calendar-task-view select').count() === 0);
  await open(memberPage, '會議協調');
  const memberMeetingCard = memberPage.locator('.mgmt-meeting-card').filter({ hasText: 'Ops Meeting' });
  check('Member can answer own meeting but cannot edit others', await memberMeetingCard.getByLabel('Ops Member的出席回覆').isEnabled() && !(await memberMeetingCard.getByLabel('嘉駿的出席回覆').isEnabled()));
  await memberMeetingCard.getByLabel('Ops Member的出席回覆').selectOption('可能出席');
  await memberPage.locator('.sync').filter({ hasText: '已同步' }).waitFor();
  check('Member self attendance UI persists', (await workspace()).state.meetings.find((row) => row.id === meeting.id)?.attendeeResponses?.find((person) => person.name === 'Ops Member')?.response === '可能出席');
  await adminPage.reload();
  await adminPage.locator('.sync').filter({ hasText: '已同步' }).waitFor();
  await open(adminPage, '行事曆');

  adminPage.once('dialog', (dialog) => dialog.dismiss());
  await dayEntry(adminPage, '2026-09-23', 'Ops Task').dragTo(day(adminPage, '2026-09-24'));
  check('Dismissed drag confirmation preserves deadline', (await workspace()).state.tasks.find((row) => row.id === task.id)?.due === '2026-09-23');
  adminPage.once('dialog', (dialog) => dialog.accept());
  await dayEntry(adminPage, '2026-09-23', 'Ops Task').dragTo(day(adminPage, '2026-09-24'));
  await adminPage.getByText('「Ops Task」已移到 2026-09-24').waitFor();
  check('Accepted drag confirmation persists deadline', (await workspace()).state.tasks.find((row) => row.id === task.id)?.due === '2026-09-24');
  check('Gantt phase overrides survive calendar drag', (await workspace()).state.activities.find((row) => row.id === activity.id)?.phasePlans?.P1?.progress === 45);
  await open(adminPage, '活動管理');
  await adminPage.getByRole('button', { name: '查看活動詳情與甘特圖' }).first().click();
  await adminPage.getByRole('dialog', { name: 'Ops Activity' }).getByRole('button', { name: '編輯活動', exact: true }).click();
  const dateEditDialog = adminPage.getByRole('dialog', { name: '編輯活動：Ops Activity' });
  await dateEditDialog.locator('input[name="eventDate"]').fill('2026-10-08');
  await dateEditDialog.getByRole('button', { name: '儲存活動變更' }).click();
  await dateEditDialog.waitFor({ state: 'hidden' });
  const afterEventDate = (await workspace()).state;
  const shiftedActivity = afterEventDate.activities.find((row) => row.id === activity.id);
  const shiftedAligned = afterEventDate.tasks.find((row) => row.id === alignedTask.id);
  const keptManual = afterEventDate.tasks.find((row) => row.id === task.id);
  check('Event date shifts matching phase task dates', shiftedActivity?.date === '2026-10-08' && shiftedAligned?.startDate === '2026-09-24' && shiftedAligned?.due === '2026-10-08');
  check('Event date retains manually overridden dates and phase plan', keptManual?.startDate === '2026-09-17' && keptManual?.due === '2026-09-24' && shiftedActivity?.startDate === '2026-08-05' && shiftedActivity?.endDate === '2026-10-16' && shiftedActivity?.phasePlans?.P1?.due === '2026-08-15');
  const beforeGrant = await workspace();
  const duplicateTraineeGrant = { ...beforeGrant.state, activities: beforeGrant.state.activities.map((row) => row.id === activity.id ? { ...row, traineeCoordinatorId: traineeId } : row) };
  await expectStatus('Activity edit cannot change member authority', admin, '/api/workspace', 403, 'PUT', { state: duplicateTraineeGrant, version: beforeGrant.version, action: 'edit_activity' });
  await expectStatus('Trainee cannot receive a second activity', admin, '/api/workspace', 400, 'PUT', { state: duplicateTraineeGrant, version: beforeGrant.version, action: 'assign_activity_authority' });
  const traineeUnauthorized = { ...beforeGrant.state, activities: beforeGrant.state.activities.map((row) => row.id === activity.id ? { ...row, description: 'Unauthorized trainee edit' } : row) };
  await expectStatus('Trainee cannot edit unrelated activity', trainee, '/api/workspace', 403, 'PUT', { state: traineeUnauthorized, version: beforeGrant.version, action: 'edit_activity' });
  const ownTraineeEdit = { ...beforeGrant.state, activities: beforeGrant.state.activities.map((row) => row.id === otherActivity.id ? { ...row, description: 'Trainee configured' } : row) };
  await expectStatus('Trainee may configure assigned activity', trainee, '/api/workspace', 200, 'PUT', { state: ownTraineeEdit, version: beforeGrant.version, action: 'edit_activity' });
  const beforeSubmit = await workspace();
  const submittedState = { ...beforeSubmit.state, activities: beforeSubmit.state.activities.map((row) => row.id === otherActivity.id ? { ...row, settingsSubmittedAt: '2026-09-23T12:00:00.000Z' } : row) };
  await expectStatus('Trainee submits assigned activity setup', trainee, '/api/workspace', 200, 'PUT', { state: submittedState, version: beforeSubmit.version, action: 'submit_activity' });
  const afterSubmit = await workspace();
  check('Submission lock persists', Boolean(afterSubmit.state.activities.find((row) => row.id === otherActivity.id)?.settingsSubmittedAt));
  const lockedEdit = { ...afterSubmit.state, activities: afterSubmit.state.activities.map((row) => row.id === otherActivity.id ? { ...row, description: 'Coordinator post-submit edit' } : row) };
  await expectStatus('Coordinator cannot edit submitted setup', coordinator, '/api/workspace', 403, 'PUT', { state: lockedEdit, version: afterSubmit.version, action: 'edit_activity' });
  await expectStatus('Manager may edit submitted setup', manager, '/api/workspace', 200, 'PUT', { state: lockedEdit, version: afterSubmit.version, action: 'edit_activity' });
  await expectStatus('Create a second member with the same display name', admin, '/api/members', 201, 'POST', { username: 'ops.member.same-name', displayName: 'Ops Member', role: 'member', password: 'Regression-Local-Only-2026' });
  const beforeAmbiguousRsvp = await workspace();
  const ambiguousRsvp = { ...beforeAmbiguousRsvp.state, meetings: beforeAmbiguousRsvp.state.meetings.map((row) => row.id === meeting.id ? { ...row, attendeeResponses: row.attendeeResponses.map((person) => person.name === 'Ops Member' ? { ...person, response: '不出席' } : person), attending: 0 } : row) };
  await expectStatus('Duplicate-name member cannot forge ambiguous attendance', member, '/api/workspace', 403, 'PUT', { state: ambiguousRsvp, version: beforeAmbiguousRsvp.version, action: 'update_meeting_attendance' });
  const ambiguousTask = { ...beforeAmbiguousRsvp.state, tasks: beforeAmbiguousRsvp.state.tasks.map((row) => row.id === otherTask.id ? { ...row, status: '進行中' } : row) };
  await expectStatus('Duplicate-name member cannot edit name-owned task', member, '/api/workspace', 403, 'PUT', { state: ambiguousTask, version: beforeAmbiguousRsvp.version, action: 'edit_task' });
  const legacyActivity = { id: 'legacy-name-activity', name: 'Legacy Name Activity', date: '2026-10-05', owner: 'Ops Coordinator', status: '規劃中', description: 'Legacy name-based grant' };
  await mutate('Seed legacy owner-name activity', 'create_activity', (current) => ({ ...current, activities: [...current.activities, legacyActivity] }));
  await expectStatus('Create a duplicate coordinator display name', admin, '/api/members', 201, 'POST', { username: 'ops.coordinator.same-name', displayName: 'Ops Coordinator', role: 'member', password: 'Regression-Local-Only-2026' });
  const beforeLegacyEdit = await workspace();
  const legacyEdit = { ...beforeLegacyEdit.state, activities: beforeLegacyEdit.state.activities.map((row) => row.id === legacyActivity.id ? { ...row, description: 'Forged legacy assignment' } : row) };
  await expectStatus('Duplicate-name coordinator cannot claim legacy activity', coordinator, '/api/workspace', 403, 'PUT', { state: legacyEdit, version: beforeLegacyEdit.version, action: 'edit_activity' });
  await expectStatus('Duplicate-name coordinator cannot view legacy registration', coordinator, `/api/registration-forms?activityId=${legacyActivity.id}`, 403);
  const managerGrant = { ...beforeLegacyEdit.state, activities: beforeLegacyEdit.state.activities.map((row) => row.id === legacyActivity.id ? { ...row, coordinatorIds: [coordinatorId] } : row) };
  await expectStatus('General manager can assign coordinator authority', manager, '/api/workspace', 200, 'PUT', { state: managerGrant, version: beforeLegacyEdit.version, action: 'assign_activity_authority' });
  check('Manager authority assignment persists', (await workspace()).state.activities.find((row) => row.id === legacyActivity.id)?.coordinatorIds?.includes(coordinatorId));
  check('No browser runtime errors', report.browserErrors.length === 0, `${report.browserErrors.length} errors`);
  await expectStatus('Active member cannot be deleted', admin, '/api/members', 409, 'POST', { action: 'delete_rejected', id: activeId });
  await expectStatus('Member cannot delete rejected applicant', member, '/api/members', 403, 'POST', { action: 'delete_rejected', id: rejectedId });
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
