import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';

// API-level check of the meetings table. Every write targets a fresh local D1 directory; no URL is accepted.
const args = Object.fromEntries(process.argv.slice(2).map(x => { const i=x.indexOf('='); return [x.slice(0,i),x.slice(i+1)]; }));
const repo = path.resolve(args['--repo'] || process.cwd());
const out = path.resolve(args['--out'] || path.join(repo, '.argo/runtime/meetings-table'));
const port = Number(args['--port'] || 8798);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid local port');
await fs.mkdir(out, {recursive:true});
const local = path.join(out,'isolated-'+randomUUID());
await fs.mkdir(local);
const configPath=path.join(local,'wrangler.json');
const dist=path.join(local,'dist');
await fs.cp(path.join(repo,'dist'),dist,{recursive:true});
const source=JSON.parse(await fs.readFile(path.join(dist,'server','wrangler.json'),'utf8'));
const password='Regression-Local-Only-2026';
await fs.writeFile(configPath,JSON.stringify({name:'puzzle-meetings-local',main:'./dist/server/'+source.main,compatibility_date:source.compatibility_date,compatibility_flags:source.compatibility_flags,no_bundle:true,rules:source.rules,assets:{directory:'./dist/client'},d1_databases:[{binding:'DB',database_name:'meetings-local',database_id:'00000000-0000-4000-8000-000000000000'}],vars:{INITIAL_ADMIN_PASSWORD:password}},null,2));
const cli=path.join(repo,'node_modules','wrangler','bin','wrangler.js');
const state=path.join(local,'state');
const env={...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:path.join(local,'wrangler-logs')};
const report={schema:1,runAt:new Date().toISOString(),origin:`http://127.0.0.1:${port}`,scope:'existing dist; fresh isolated local D1; no deploy',checks:[]};
const check=(name,ok,detail='')=>{report.checks.push({name,ok,detail});if(!ok)throw Error(name+': '+detail);};
const wrangler=(extra)=>{const r=spawnSync(process.execPath,[cli,'d1','execute','DB','--local','--persist-to',state,'--config',configPath,...extra],{cwd:local,env,encoding:'utf8',windowsHide:true});if(r.status!==0)throw Error('Local wrangler operation failed: '+r.stderr.slice(-1500));return r.stdout;};
const query=(sql)=>JSON.parse(wrangler(['--command',sql,'--json']).trim().replace(/^[^[]*/,''))[0].results;
let server;
try {
  await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',()=>reject(Error('Refusing occupied local port')));probe.listen(port,'127.0.0.1',()=>probe.close(resolve));});
  const sql=(await fs.readdir(path.join(repo,'drizzle'))).filter(x=>x.endsWith('.sql')).sort();
  const migration=sql.find(x=>x.endsWith('_meetings_table.sql'));
  check('Meetings migration exists',Boolean(migration),sql.join(','));
  for(const file of sql.filter(x=>x!==migration)) wrangler(['--file',path.join(repo,'drizzle',file)]);
  // Legacy state: two meetings (one with every optional field) inside the single JSON blob, as production stores them.
  const legacyMeetings=[
    {id:'m-legacy-1',title:'Kickoff',activityId:'a-1',time:'2026-10-01T10:00',status:'planned',type:'online',organizer:'Org',recorder:'Rec',endTime:'2026-10-01T11:00',location:'Room',meetingLink:'https://example.test/m',agenda:'Agenda',attendees:['A','B'],attending:1,total:2,attendeeResponses:[{name:'A',response:'出席'},{name:'B',response:'待回覆'}]},
    {id:'m-legacy-2',title:'Wrap-up',activityId:'a-1',time:'2026-10-09T10:00',status:'planned'}
  ];
  const legacy={activities:[{id:'a-1',name:'Legacy activity',date:'2026-10-09',owner:'Owner',status:'planning',description:''}],tasks:[],meetings:legacyMeetings,notices:[]};
  const seedFile=path.join(local,'seed.sql');
  await fs.writeFile(seedFile,`INSERT INTO workspace_states (id,data,version,updated_at,updated_by) VALUES (1,'${JSON.stringify(legacy).replaceAll("'","''")}',5,'2026-10-01T00:00:00.000Z','seed');`);
  wrangler(['--file',seedFile]);
  wrangler(['--file',path.join(repo,'drizzle',migration)]);
  const migrated=query('SELECT id,activity_id,position,data FROM meetings ORDER BY position');
  check('Migration copies every legacy meeting in order',migrated.length===2&&migrated[0].id==='m-legacy-1'&&migrated[1].id==='m-legacy-2'&&migrated.every((r,i)=>r.position===i&&r.activity_id==='a-1'),JSON.stringify(migrated.map(r=>[r.id,r.position])));
  check('Migrated rows are byte-for-content identical',migrated.every((r,i)=>JSON.stringify(JSON.parse(r.data))===JSON.stringify(legacyMeetings[i])));
  check('Legacy JSON blob is left untouched',query('SELECT json_array_length(data,\'$.meetings\') AS n, version FROM workspace_states WHERE id=1')[0].n===2);

  const log=await fs.open(path.join(local,'server.log'),'w');
  server=spawn(process.execPath,[cli,'dev','--config',configPath,'--local','--persist-to',state,'--ip','127.0.0.1','--port',String(port),'--inspector-port','0'],{cwd:local,env,windowsHide:true,stdio:['ignore',log.fd,log.fd]});
  const base=report.origin;
  for(let i=0;i<90;i++){if(server.exitCode!==null)throw Error('Local server exited during startup');try{if((await fetch(base)).status===200)break;}catch{}if(i===89)throw Error('Local server startup timeout');await new Promise(r=>setTimeout(r,500));}
  const session=()=>{const jar=new Map();return async(url,method='GET',data)=>{const res=await fetch(base+url,{method,headers:{Origin:base,'Content-Type':'application/json',Cookie:[...jar].map(([k,v])=>k+'='+v).join('; ')},body:data===undefined?undefined:JSON.stringify(data)});for(const c of res.headers.getSetCookie?.()??[]){const [kv]=c.split(';');const i=kv.indexOf('=');jar.set(kv.slice(0,i),kv.slice(i+1));}let json=null;try{json=await res.json();}catch{}return {status:res.status,json};};};
  const admin=session(),member=session(),anon=session();
  const code=async(name,call,expected)=>{const r=await call;check(name,r.status===expected,`HTTP ${r.status}, expected ${expected}: ${JSON.stringify(r.json)?.slice(0,200)}`);return r;};
  await code('Anonymous workspace denied',anon('/api/workspace'),401);
  await code('Admin login',admin('/api/auth/login','POST',{username:'kao19950411',password}),200);
  const first=await code('Admin reads workspace',admin('/api/workspace'),200);
  check('GET returns migrated meetings in original shape',JSON.stringify(first.json.state.meetings)===JSON.stringify(legacyMeetings));
  check('GET keeps other collections and version',first.json.version===5&&first.json.state.activities.length===1&&first.json.state.notices.length===0);

  const created={id:'m-new-1',title:'Retro',activityId:'a-1',time:'2026-10-20T10:00',status:'planned',attendees:[]};
  const auditBefore=query('SELECT count(*) AS n FROM audit_logs')[0].n;
  await code('Admin creates meeting',admin('/api/workspace','PUT',{state:{...first.json.state,meetings:[...first.json.state.meetings,created]},version:5,action:'create_meeting'}),200);
  const second=(await admin('/api/workspace')).json;
  check('Created meeting is read back last',second.version===6&&second.state.meetings.length===3&&second.state.meetings[2].id==='m-new-1'&&JSON.stringify(second.state.meetings.slice(0,2))===JSON.stringify(legacyMeetings));
  check('Table and audit log updated, blob no longer carries meetings',query('SELECT count(*) AS n FROM meetings')[0].n===3&&query('SELECT count(*) AS n FROM audit_logs')[0].n===auditBefore+1&&query('SELECT json_array_length(data,\'$.meetings\') AS n FROM workspace_states WHERE id=1')[0].n===0);

  const stale=await code('Stale version is rejected',admin('/api/workspace','PUT',{state:{...second.state,meetings:second.state.meetings.slice(0,1)},version:5,action:'update_workspace'}),409);
  check('409 returns latest meetings and writes nothing',stale.json.state.meetings.length===3&&query('SELECT count(*) AS n FROM meetings')[0].n===3&&query('SELECT version FROM workspace_states WHERE id=1')[0].version===6);

  const edited=second.state.meetings.map(m=>m.id==='m-legacy-2'?{...m,title:'Wrap-up (edited)',location:'Hall'}:m);
  await code('Admin edits meeting',admin('/api/workspace','PUT',{state:{...second.state,meetings:edited},version:6,action:'edit_meeting'}),200);
  const third=(await admin('/api/workspace')).json;
  check('Edit persists and keeps order',third.version===7&&third.state.meetings.map(m=>m.id).join()==='m-legacy-1,m-legacy-2,m-new-1'&&third.state.meetings[1].title==='Wrap-up (edited)');
  const noMeetingChange=await code('Task-only style write leaves meetings alone',admin('/api/workspace','PUT',{state:third.state,version:7,action:'update_workspace'}),200);
  check('Unchanged meetings survive a no-op write',(await admin('/api/workspace')).json.state.meetings.length===3&&noMeetingChange.json.version===8);
  await code('Deleting a meeting is still refused',admin('/api/workspace','PUT',{state:{...third.state,meetings:third.state.meetings.slice(1)},version:8,action:'edit_meeting'}),403);
  check('Refused write changed nothing',query('SELECT count(*) AS n FROM meetings')[0].n===3&&query('SELECT version FROM workspace_states WHERE id=1')[0].version===8);

  await code('Create plain member',admin('/api/members','POST',{username:'meetings.member',displayName:'Meetings Member',role:'member',password}),201);
  await code('Member login',member('/api/auth/login','POST',{username:'meetings.member',password}),200);
  const memberView=await code('Member reads same meetings',member('/api/workspace'),200);
  check('Member sees identical meeting list',JSON.stringify(memberView.json.state.meetings)===JSON.stringify((await admin('/api/workspace')).json.state.meetings));
  const forged=memberView.json.state.meetings.map(m=>m.id==='m-new-1'?{...m,title:'Hijacked'}:m);
  await code('Member cannot edit meeting details',member('/api/workspace','PUT',{state:{...memberView.json.state,meetings:forged},version:8,action:'edit_meeting'}),403);
  check('Forbidden edit left the table unchanged',query('SELECT data FROM meetings WHERE id=\'m-new-1\'')[0].data.includes('Retro'));
  const baseState=(await admin('/api/workspace')).json;
  const left={id:'race-left',title:'Left',activityId:'a-1',time:'2026-11-01T10:00',status:'planned'};
  const right={id:'race-right',title:'Right',activityId:'a-1',time:'2026-11-01T10:00',status:'planned'};
  const auditRaceBefore=query('SELECT count(*) AS n FROM audit_logs')[0].n;
  const raced=await Promise.all([left,right].map(item=>admin('/api/workspace','PUT',{state:{...baseState.state,meetings:[...baseState.state.meetings,item]},version:baseState.version,action:'create_meeting'})));
  check('Concurrent actual D1 writes have one winner and one conflict',raced.map(r=>r.status).sort().join(',')==='200,409',JSON.stringify(raced.map(r=>r.status)));
  const afterRace=(await admin('/api/workspace')).json;
  const winner=raced[0].status===200?left:right;
  check('Actual D1 keeps winner and increments audit/version once',afterRace.version===baseState.version+1&&afterRace.state.meetings.at(-1)?.id===winner.id&&query('SELECT count(*) AS n FROM audit_logs')[0].n===auditRaceBefore+1&&query('SELECT count(*) AS n FROM meetings WHERE id IN (\'race-left\',\'race-right\')')[0].n===1);
  check('No server errors before injected failure',!(await fs.readFile(path.join(local,'server.log'),'utf8')).includes('[ERROR]'));
  wrangler(['--command',"CREATE TRIGGER fail_test_meeting BEFORE INSERT ON meetings WHEN NEW.id='forced-failure' BEGIN SELECT RAISE(ABORT,'injected failure'); END"]);
  const auditRollbackBefore=query('SELECT count(*) AS n FROM audit_logs')[0].n;
  const failed=await admin('/api/workspace','PUT',{state:{...afterRace.state,meetings:[...afterRace.state.meetings,{...left,id:'forced-failure'}]},version:afterRace.version,action:'create_meeting'});
  check('Injected real D1 batch failure is rejected',failed.status>=500,`HTTP ${failed.status}`);
  const afterFailure=(await admin('/api/workspace')).json;
  check('Injected failure rolls back workspace, meetings and audit',afterFailure.version===afterRace.version&&JSON.stringify(afterFailure.state)===JSON.stringify(afterRace.state)&&query('SELECT count(*) AS n FROM audit_logs')[0].n===auditRollbackBefore);
}catch(e){report.failure=e.message;process.exitCode=1;}finally{if(server){if(process.platform==='win32')spawnSync('taskkill',['/pid',String(server.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});else server.kill();}report.passed=!report.failure && report.checks.every(x=>x.ok);if(!report.passed)process.exitCode=1;await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,failure:report.failure,checks:report.checks.length},null,2));}
