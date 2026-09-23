import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import net from 'node:net';

// No external URL is accepted: all writes target a fresh local D1 directory.
const args = Object.fromEntries(process.argv.slice(2).map(x => { const i=x.indexOf('='); return [x.slice(0,i),x.slice(i+1)]; }));
const repo = path.resolve(args['--repo'] || process.cwd());
const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(args['--out'] || path.join(repo, '.argo/runtime/screenshots', new Date().toISOString().replaceAll(':','-')));
const port = Number(args['--port'] || 8797);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid local port');
await fs.mkdir(out, {recursive:true});
const local = path.join(out,'isolated-'+randomUUID());
await fs.mkdir(local);
const configPath=path.join(local,'wrangler.json');
const dist=path.join(local,'dist');
await fs.cp(path.join(repo,'dist'),dist,{recursive:true});
const source=JSON.parse(await fs.readFile(path.join(dist,'server','wrangler.json'),'utf8'));
const config={name:'puzzle-regression-local',main:'./dist/server/'+source.main,compatibility_date:source.compatibility_date,compatibility_flags:source.compatibility_flags,no_bundle:true,rules:source.rules,assets:{directory:'./dist/client'},d1_databases:[{binding:'DB',database_name:'regression-local',database_id:'00000000-0000-4000-8000-000000000000'}],vars:{INITIAL_ADMIN_PASSWORD:'Regression-Local-Only-2026'}};
await fs.writeFile(configPath,JSON.stringify(config,null,2));
const cli=path.join(repo,'node_modules','wrangler','bin','wrangler.js');
const state=path.join(local,'state');
const env={...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:path.join(local,'wrangler-logs')};
const report={schema:1,runAt:new Date().toISOString(),origin:`http://127.0.0.1:${port}`,scope:'existing dist; fresh isolated local D1; no deploy',checks:[],screenshots:[],browserErrors:[],networkErrors:[],navigationCancellations:[],comparison:null};
const check=(name,ok,detail='')=>{report.checks.push({name,ok,detail});if(!ok)throw Error(name+': '+detail);};
const wrangler=(extra)=>{const r=spawnSync(process.execPath,[cli,...extra,'--config',configPath],{cwd:local,env,encoding:'utf8',windowsHide:true});if(r.status!==0)throw Error('Local wrangler operation failed: '+r.stderr.slice(-1500));};
let server,browser;
try {
  await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',()=>reject(Error('Refusing occupied local port')));probe.listen(port,'127.0.0.1',()=>probe.close(resolve));});
  const sql=(await fs.readdir(path.join(repo,'drizzle'))).filter(x=>x.endsWith('.sql')).sort();
  for(const file of sql) wrangler(['d1','execute','DB','--local','--persist-to',state,'--file',path.join(repo,'drizzle',file)]);
  report.migrations=sql;
  const log=await fs.open(path.join(local,'server.log'),'w');
  server=spawn(process.execPath,[cli,'dev','--config',configPath,'--local','--persist-to',state,'--ip','127.0.0.1','--port',String(port),'--inspector-port','0'],{cwd:local,env,windowsHide:true,stdio:['ignore',log.fd,log.fd]});
  const base=report.origin;
  for(let i=0;i<90;i++){if(server.exitCode!==null)throw Error('Local server exited during startup');try{if((await fetch(base)).status===200)break;}catch{}if(i===89)throw Error('Local server startup timeout');await new Promise(r=>setTimeout(r,500));}
  const pw=args['--playwright'] || process.env.REGRESSION_PLAYWRIGHT || path.join(process.env.USERPROFILE || process.env.HOME || '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
  const {chromium}=await import(pathToFileURL(pw));
  browser=await chromium.launch({headless:true,...(args['--browser'] || process.env.REGRESSION_BROWSER ? {executablePath:args['--browser'] || process.env.REGRESSION_BROWSER} : process.platform==='win32' ? {channel:'chrome'} : {})});
  report.browserVersion=browser.version();
  async function context(){const c=await browser.newContext({locale:'zh-TW',timezoneId:'Asia/Taipei',colorScheme:'light',reducedMotion:'reduce',viewport:{width:1440,height:1000}});await c.addInitScript(() => {const NativeDate=Date;class FixedDate extends NativeDate {constructor(...args){super(...(args.length?args:['2026-09-23T12:00:00.000Z']));}static now(){return NativeDate.parse('2026-09-23T12:00:00.000Z');}}window.Date=FixedDate;});return c;}
  const admin=await context(),member=await context(),coordinator=await context(),anon=await context();
  const authTransitions=new WeakMap();
  const api=async(c,url,method='GET',data)=>c.request.fetch(base+url,{method,data,headers:{Origin:base}});
  const status=async(name,c,url,expected,method,data)=>{const r=await api(c,url,method,data);check(name,r.status()===expected,`HTTP ${r.status()}, expected ${expected}: ${r.status()===expected?'':await r.text()}`);return r;};
  await status('Anonymous workspace denied',anon,'/api/workspace',401);
  await status('Anonymous member list denied',anon,'/api/members',403);
  const page=await admin.newPage();
  function observe(p,role){p.on('pageerror',e=>report.browserErrors.push({role,type:'pageerror',message:e.message}));p.on('console',m=>{if(m.type()==='error')report.browserErrors.push({role,type:'console',message:m.text()});});p.on('requestfailed',r=>{const item={role,url:new URL(r.url()).pathname,error:r.failure()?.errorText,resourceType:r.resourceType(),isNavigation:r.isNavigationRequest(),rsc:r.headers()['rsc']||null,authTransition:authTransitions.get(p)||null};if(authTransitions.has(p)&&(r.isNavigationRequest()||r.headers()['rsc']==='1')&&new URL(r.url()).origin===base&&item.url==='/'&&item.error==='net::ERR_ABORTED')report.navigationCancellations.push(item);else report.networkErrors.push(item);});p.on('response',r=>{if(r.status()>=400)report.networkErrors.push({role,url:new URL(r.url()).pathname,status:r.status()});});}
  observe(page,'admin');
  async function shot(p,name){await p.evaluate(()=>document.fonts.ready);await p.screenshot({path:path.join(out,name+'.png'),fullPage:true,animations:'disabled'});const bytes=await fs.readFile(path.join(out,name+'.png'));const structure=await p.locator('body').innerText();report.screenshots.push({name,sha256:createHash('sha256').update(bytes).digest('hex'),text:structure});}
  async function login(p,username){await p.goto(base);authTransitions.set(p,'login');await p.locator('#login-username').fill(username);await p.locator('#login-password').fill('Regression-Local-Only-2026');await p.locator('form').getByRole('button',{name:'登入',exact:true}).click();await p.getByRole('heading',{name:'營運總覽',exact:true}).waitFor();await p.locator('.sync').filter({hasText:'已同步'}).waitFor();authTransitions.delete(p);}
  await page.goto(base);await shot(page,'login-desktop');
  await page.setViewportSize({width:390,height:844});await shot(page,'login-mobile');await page.setViewportSize({width:1440,height:1000});
  const pattern=await page.locator('#login-username').getAttribute('pattern');
  const patternValid=await page.evaluate(p=>{try{new RegExp(p,'v');return true;}catch{return false;}},pattern);
  report.checks.push({name:'Login HTML pattern compiles with v flag',ok:patternValid,detail:patternValid?'':'Invalid HTML pattern'});
  await status('Wrong password rejected',anon,'/api/auth/login',401,'POST',{username:'invalid.user',password:'Wrong-Password-2026'});
  await login(page,'kao19950411');check('Admin UI login',true);
  await status('Admin member list allowed',admin,'/api/members',200);
  await status('Create isolated member',admin,'/api/members',201,'POST',{username:'regression.member',displayName:'Regression Member',role:'member',password:'Regression-Local-Only-2026'});
  const createdCoordinator=await status('Create isolated coordinator',admin,'/api/members',201,'POST',{username:'regression.coordinator',displayName:'Regression Coordinator',role:'coordinator',password:'Regression-Local-Only-2026'});
  await status('Coordinator API login',coordinator,'/api/auth/login',200,'POST',{username:'regression.coordinator',password:'Regression-Local-Only-2026'});
  await status('Coordinator registration private API allowed',coordinator,'/api/registration-forms?activityId=regression-activity',200);
  await status('Coordinator member management allowed',coordinator,'/api/members',200);
  wrangler(['d1','execute','DB','--local','--persist-to',state,'--command',"UPDATE members SET created_at='2026-09-23T12:00:00.000Z';"]);
  const initial=await (await api(admin,'/api/workspace')).json();
  await status('Save isolated activity',admin,'/api/workspace',200,'PUT',{state:{activities:[{id:'regression-activity',name:'Regression Activity',date:'2026-10-01',owner:'QA',status:'規劃中',description:'Isolated fixture'}],tasks:[],meetings:[],notices:[]},version:initial.version,action:'create_activity'});
  const scheduled=(await (await api(admin,'/api/workspace')).json());
  const tasks=[
    {id:'admin-calendar-task',name:'Admin Calendar Task',activityId:'regression-activity',assignee:'嘉駿',due:'2026-09-23',startDate:'2026-09-20',status:'待處理',blocker:'',phaseId:'P7'},
    {id:'member-calendar-task',name:'Member Calendar Task',activityId:'regression-activity',assignee:'Regression Member',due:'2026-09-23',startDate:'2026-09-20',status:'待處理',blocker:'',phaseId:'P7'},
    {id:'aligned-calendar-task',name:'Aligned Calendar Task',activityId:'regression-activity',assignee:'嘉駿',due:'2026-10-01',startDate:'2026-09-17',status:'待處理',blocker:'',phaseId:'P7'},
  ];
  await status('Save isolated task fixtures',admin,'/api/workspace',200,'PUT',{state:{...scheduled.state,tasks},version:scheduled.version,action:'create_task'});
  await page.reload();await page.locator('.sync').filter({hasText:'已同步'}).waitFor();
  const labels=['營運總覽','活動管理','任務中心','報名表單','行事曆','會議協調','組織與角色','成員管理','通知中心','系統設定'];
  for(const label of labels){await page.getByRole('navigation',{name:'主要導覽',exact:true}).getByRole('button',{name:label,exact:true}).click();await page.getByRole('heading',{name:label,exact:true,level:1}).waitFor();check('Admin navigation '+label,true);}
  await page.getByRole('navigation',{name:'主要導覽',exact:true}).getByRole('button',{name:'行事曆',exact:true}).click();
  check('Calendar defaults to own tasks',await page.getByText('Admin Calendar Task').count()>0&&await page.getByText('Member Calendar Task').count()===0);
  await page.locator('.calendar-task-view select').selectOption('all');
  check('Admin can see all tasks',await page.getByText('Member Calendar Task').count()>0);
  await page.locator('.calendar-task-view select').selectOption('self');
  await page.getByRole('button',{name:'改期',exact:true}).click();
  await page.locator('input[name="moveDate"]').fill('2026-09-24');
  page.once('dialog',dialog=>dialog.dismiss());
  await page.getByRole('button',{name:'儲存日期'}).click();
  const afterCancel=(await (await api(admin,'/api/workspace')).json());
  check('Dismissed calendar confirmation keeps task date',afterCancel.state.tasks.find(row=>row.id==='admin-calendar-task')?.due==='2026-09-23');
  await page.getByRole('button',{name:'關閉改期表單'}).click();
  await page.getByRole('button',{name:'＋ 任務'}).click();
  await page.locator('.calendar-composer select[name="activityId"]').selectOption('regression-activity');
  await page.locator('.calendar-composer select[name="phaseId"]').selectOption('P7');
  check('Calendar task dates derive from activity',await page.locator('.calendar-composer input[name="startDate"]').inputValue()==='2026-09-17'&&await page.locator('.calendar-composer input[name="due"]').inputValue()==='2026-10-01');
  await page.getByRole('navigation',{name:'主要導覽',exact:true}).getByRole('button',{name:'活動管理',exact:true}).click();
  await page.getByRole('button',{name:'＋ 建立活動'}).click();
  await page.locator('.mgmt-dialog input[name="name"]').fill('Preserve unfinished activity');
  await page.locator('.mgmt-dialog').dispatchEvent('click',{clientX:0,clientY:0});
  check('Accidental backdrop click retains activity form',await page.locator('.mgmt-dialog').isVisible()&&await page.locator('.mgmt-dialog input[name="name"]').inputValue()==='Preserve unfinished activity');
  await page.getByRole('button',{name:'關閉',exact:true}).click();
  for(const [name,label] of [['dashboard','營運總覽'],['activities','活動管理'],['members','成員管理']]){await page.getByRole('navigation',{name:'主要導覽',exact:true}).getByRole('button',{name:label,exact:true}).click();await page.waitForTimeout(350);await shot(page,'admin-'+name+'-desktop');}
  await page.setViewportSize({width:390,height:844});
  for(const [name,label] of [['dashboard','總覽'],['activities','活動']]){await page.getByRole('navigation',{name:'手機導覽',exact:true}).getByRole('button',{name:label,exact:true}).click();await shot(page,'admin-'+name+'-mobile');check('Mobile no document overflow '+name,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  await page.getByRole('button',{name:'更多功能',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'成員管理'}).click();await page.waitForTimeout(350);await shot(page,'admin-members-mobile');
  const mp=await member.newPage();observe(mp,'member');await login(mp,'regression.member');check('Member UI login',true);
  const currentWorkspace=(await (await api(admin,'/api/workspace')).json());
  const forbidden={...currentWorkspace.state,tasks:currentWorkspace.state.tasks.map(row=>row.id==='admin-calendar-task'?{...row,due:'2026-09-24'}:row),notices:[{id:'blocked-notice',title:'blocked',detail:'blocked',createdAt:'2026-09-23T12:00:00Z',read:false},...currentWorkspace.state.notices]};
  await status('Member cannot reschedule someone else task',member,'/api/workspace',403,'PUT',{state:forbidden,version:currentWorkspace.version,action:'reschedule'});
  await status('Member cannot bypass date check with action label',member,'/api/workspace',403,'PUT',{state:forbidden,version:currentWorkspace.version,action:'update_workspace'});
  const stolen={...currentWorkspace.state,tasks:currentWorkspace.state.tasks.map(row=>row.id==='admin-calendar-task'?{...row,assignee:'Regression Member'}:row)};
  await status('Member cannot reassign someone else task',member,'/api/workspace',403,'PUT',{state:stolen,version:currentWorkspace.version,action:'update_workspace'});
  await mp.getByRole('navigation',{name:'主要導覽',exact:true}).getByRole('button',{name:'行事曆',exact:true}).click();
  check('Member calendar hides others tasks',await mp.getByText('Member Calendar Task').count()>0&&await mp.getByText('Admin Calendar Task').count()===0);
  await status('Member workspace allowed',member,'/api/workspace',200);
  await status('Member registration private API denied',member,'/api/registration-forms?activityId=regression-activity',403);
  await status('Member list denied',member,'/api/members',403);
  await status('Member mutation denied',member,'/api/members',403,'PATCH',{id:'admin-kao19950411',status:'disabled'});
  check('Member admin navigation hidden',await mp.getByRole('navigation',{name:'主要導覽',exact:true}).getByRole('button',{name:'成員管理',exact:true}).count()===0);
  await shot(mp,'member-dashboard-desktop');
  await mp.getByRole('navigation',{name:'主要導覽',exact:true}).getByRole('button',{name:'系統設定',exact:true}).click();authTransitions.set(mp,'logout');await mp.getByRole('button',{name:'登出此裝置'}).click();await mp.locator('#login-username').waitFor();authTransitions.delete(mp);check('Member UI logout',true);await status('Logged out session denied',member,'/api/workspace',401);
  await page.setViewportSize({width:1440,height:1000});await page.getByRole('navigation',{name:'主要導覽',exact:true}).getByRole('button',{name:'行事曆',exact:true}).click();
  await page.getByRole('button',{name:'改期',exact:true}).click();
  await page.locator('input[name="moveDate"]').fill('2026-09-24');
  page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'儲存日期'}).click();
  await page.getByText('「Admin Calendar Task」已移到 2026-09-24').waitFor();
  const afterMove=(await (await api(admin,'/api/workspace')).json());
  check('Confirmed calendar task reschedule persists',afterMove.state.tasks.find(row=>row.id==='admin-calendar-task')?.due==='2026-09-24');
  await page.getByRole('button',{name:'下一個月'}).click();
  await page.locator('.calendar-day[aria-label^="2026-10-01"] .calendar-day-select').click();
  await page.getByRole('button',{name:'改期',exact:true}).first().click();
  await page.locator('input[name="moveDate"]').fill('2026-10-08');
  page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'儲存日期'}).click();
  await page.getByText('「Regression Activity」已移到 2026-10-08').waitFor();
  const afterActivityMove=(await (await api(admin,'/api/workspace')).json());
  check('Activity move shifts phase-aligned task only',afterActivityMove.state.activities.find(row=>row.id==='regression-activity')?.date==='2026-10-08'&&afterActivityMove.state.tasks.find(row=>row.id==='aligned-calendar-task')?.due==='2026-10-08'&&afterActivityMove.state.tasks.find(row=>row.id==='admin-calendar-task')?.due==='2026-09-24');
  await page.getByRole('navigation',{name:'主要導覽',exact:true}).getByRole('button',{name:'系統設定',exact:true}).click();authTransitions.set(page,'logout');await page.getByRole('button',{name:'登出此裝置'}).click();await page.locator('#login-username').waitFor();authTransitions.delete(page);check('Admin UI logout',true);
  report.checks.push({name:'No browser console or runtime errors',ok:report.browserErrors.length===0,detail:`${report.browserErrors.length} errors`});
  check('No failed browser network responses',report.networkErrors.length===0,`${report.networkErrors.length} errors`);
  if(args['--compare']){const previous=JSON.parse(await fs.readFile(path.join(path.resolve(args['--compare']),'report.json'),'utf8'));report.comparison=report.screenshots.map(s=>{const before=previous.screenshots.find(x=>x.name===s.name);return {name:s.name,exactImageMatch:before?.sha256===s.sha256,exactTextMatch:before?.text===s.text};});check('Before/after screenshot and text comparison',report.comparison.every(x=>x.exactImageMatch&&x.exactTextMatch),'Exact comparison; review any intentional change explicitly');}
}catch(e){report.failure=e.message;process.exitCode=1;}finally{if(browser)await browser.close();if(server){if(process.platform==='win32')spawnSync('taskkill',['/pid',String(server.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});else server.kill();}report.passed=!report.failure && report.checks.every(x=>x.ok);if(!report.passed)process.exitCode=1;await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,out,failure:report.failure}));}
