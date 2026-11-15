import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

globalThis.__orgEnv = {}; globalThis.__orgHeaders = new Headers();
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export const env=globalThis.__orgEnv', shortCircuit: true };
  if (specifier === 'next/headers') return { url: 'data:text/javascript,export async function headers(){return globalThis.__orgHeaders}', shortCircuit: true };
  if (specifier.startsWith('@/app/')) return { url: pathToFileURL(path.resolve('app',specifier.slice(6)+'.ts')).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { GET, PUT } = await import('../../app/api/workspace/route.ts');
const files = readdirSync('drizzle').filter(n => /^\d{4}_.+\.sql$/.test(n)).sort();
const migration = '0014_organization_meetings.sql';
const hashes = t => createHash('sha256').update(t).digest('hex');
const tokens = { admin:'a'.repeat(64), coord:'c'.repeat(64), invite:'i'.repeat(64), other:'d'.repeat(64) };
// Cookies in the actual service are lowercase hex.
tokens.invite = 'b'.repeat(64);
const origin = 'https://puzzle.example';
function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  for (const f of files) db.exec(readFileSync('drizzle/'+f,'utf8'));
  const add=db.prepare('INSERT INTO members(user_id,username,email,display_name,role,status,created_at) VALUES(?,?,?,?,?,?,?)');
  add.run('coord','coord123','c@example.test','Coordinator','coordinator','active','2026');
  add.run('invite','invite123','i@example.test','Same','member','active','2026');
  add.run('other','other123','o@example.test','Same','member','active','2026');
  for (const [who,t] of Object.entries(tokens)) db.prepare('INSERT INTO admin_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hashes(t),who==='admin'?'admin-kao19950411':who,Date.now()+60000);
  const state={activities:[],tasks:[],meetings:[],notices:[]};
  db.prepare('INSERT INTO workspace_states(id,data,version,updated_at,updated_by) VALUES(1,?,1,?,?)').run(JSON.stringify(state),'2026','admin');
  const org={id:'private',title:'Private Title',activityId:'',meetingScope:'organization',invitedMemberIds:['coord','invite'],time:'2026-12-01T09:00',status:'待確認',agenda:'Secret Agenda',meetingLink:'https://example.test/secret'};
  const publicRow={id:'old',title:'Old meeting',activityId:'act',time:'2026-12-01T10:00',status:'待確認'};
  const insert=db.prepare('INSERT INTO meetings(id,activity_id,position,data) VALUES(?,?,?,?)');
  insert.run('old','act',0,JSON.stringify(publicRow));insert.run('private',null,1,JSON.stringify(org));
  function stmt(sql,values=[]){return {sql,values,bind(...v){return stmt(sql,v)},async first(){const r=db.prepare(sql).get(...values);return r?{...r}:null},async all(){return {results:db.prepare(sql).all(...values).map(r=>({...r}))}},async run(){return {meta:{changes:Number(db.prepare(sql).run(...values).changes)}}}};}
  let beforeWorkspaceRead = null, beforeBatch = null, afterFirstBatchStatement = null;
  globalThis.__orgEnv.DB={prepare:sql=>{if (sql.startsWith('SELECT data,version,updated_at,') && beforeWorkspaceRead) { const callback=beforeWorkspaceRead; beforeWorkspaceRead=null; callback(); } return stmt(sql)},async batch(stmts){if(beforeBatch){const callback=beforeBatch;beforeBatch=null;callback()}db.exec('BEGIN');try{const r=[];for(const statement of stmts){r.push({meta:{changes:Number(db.prepare(statement.sql).run(...statement.values).changes)}});if(r.length===1&&afterFirstBatchStatement){const callback=afterFirstBatchStatement;afterFirstBatchStatement=null;callback()}}db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}};
  return {db,org,publicRow,beforeRead(fn){beforeWorkspaceRead=fn},beforeBatch(fn){beforeBatch=fn},afterFirst(fn){afterFirstBatchStatement=fn},close(){delete globalThis.__orgEnv.DB;db.close()}};
}
function as(who){globalThis.__orgHeaders=new Headers({cookie:`puzzle_admin_session=${tokens[who]}`});}
async function read(who){as(who);const r=await GET();assert.equal(r.status,200);return r.json();}
async function put(who,state,version,action){as(who);return PUT(new Request(origin+'/api/workspace',{method:'PUT',headers:{origin,'content-type':'application/json'},body:JSON.stringify({state,version,action})}));}

test('0014 preserves legacy rows and accepts null activity',()=>{const d=new DatabaseSync(':memory:');try{for(const f of files.filter(f=>f<migration))d.exec(readFileSync('drizzle/'+f,'utf8'));d.prepare('INSERT INTO meetings(id,activity_id,position,data) VALUES(?,?,?,?)').run('m','a',7,'{"id":"m","activityId":"a"}');const before={...d.prepare('SELECT * FROM meetings').get()};d.exec(readFileSync('drizzle/'+migration,'utf8'));assert.deepEqual({...d.prepare('SELECT * FROM meetings').get()},before);d.prepare('INSERT INTO meetings(id,activity_id,position,data) VALUES(?,?,?,?)').run('org',null,8,'{}');assert.ok(d.prepare("SELECT name FROM sqlite_master WHERE name='meetings_activity_idx'").get());}finally{d.close()}});

test('private meeting visible only to admin and invited IDs; stale 409 is filtered',async()=>{const f=fixture();try{for(const who of ['admin','coord','invite'])assert.ok((await read(who)).state.meetings.some(m=>m.id==='private'));const outside=await read('other');assert.deepEqual(outside.state.meetings.map(m=>m.id),['old']);const stale=await put('other',outside.state,0,'update_workspace');assert.equal(stale.status,409);assert.doesNotMatch(JSON.stringify(await stale.json()),/Private Title|Secret Agenda|example\.test\/secret/);}finally{f.close()}});

test('non-invitee saving unrelated state preserves hidden meeting, order and rejects ID injection',async()=>{const f=fixture();try{const outside=await read('other');const saved=await put('other',outside.state,1,'update_workspace');assert.equal(saved.status,200);const rows=f.db.prepare('SELECT id,data FROM meetings ORDER BY position').all();assert.deepEqual(rows.map(r=>r.id),['old','private']);assert.deepEqual(JSON.parse(rows[1].data),f.org);const hacked={...outside.state,meetings:[...outside.state.meetings,f.org]};assert.equal((await put('other',hacked,2,'update_workspace')).status,403);}finally{f.close()}});

test('coordinator can create organization meeting and is automatically invited',async()=>{const f=fixture();try{const before=await read('coord');const candidate={id:'new',title:'New',activityId:'',meetingScope:'organization',invitedMemberIds:['invite'],time:'2026-12-02T09:00',status:'待確認'};const result=await put('coord',{...before.state,meetings:[...before.state.meetings,candidate]},1,'create_meeting');assert.equal(result.status,200);const body=await result.json();assert.ok(body.state.meetings.find(m=>m.id==='new').invitedMemberIds.includes('coord'));assert.equal(f.db.prepare("SELECT activity_id FROM meetings WHERE id='new'").get().activity_id,null);}finally{f.close()}});

test('revoked invitation is filtered on the next read and cannot modify hidden meeting',async()=>{const f=fixture();try{const before=await read('admin');const revised=before.state.meetings.map(m=>m.id==='private'?{...m,invitedMemberIds:['coord']}:m);assert.equal((await put('admin',{...before.state,meetings:revised},1,'edit_meeting')).status,200);const now=await read('invite');assert.deepEqual(now.state.meetings.map(m=>m.id),['old']);const forged={...now.state,meetings:[...now.state.meetings,{...f.org,agenda:'Hijack'}]};assert.equal((await put('invite',forged,2,'edit_meeting')).status,403);assert.equal(JSON.parse(f.db.prepare("SELECT data FROM meetings WHERE id='private'").get().data).agenda,'Secret Agenda');}finally{f.close()}});

test('existing private meeting cannot be relabelled as public',async()=>{const f=fixture();try{const before=await read('admin');const revised=before.state.meetings.map(m=>m.id==='private'?{...m,meetingScope:undefined,activityId:'act'}:m);assert.equal((await put('admin',{...before.state,meetings:revised},1,'edit_meeting')).status,403);assert.doesNotMatch(JSON.stringify(await read('other')),/Private Title|Secret Agenda/);}finally{f.close()}});

test('rescheduling a private meeting does not broadcast title or details in notices',async()=>{const f=fixture();try{const before=await read('admin');const revised=before.state.meetings.map(m=>m.id==='private'?{...m,time:'2026-12-02T09:00'}:m);const notice={id:'n',title:'排程異動：Private Title',detail:'Secret Agenda',createdAt:'2026',read:false};const res=await put('admin',{...before.state,meetings:revised,notices:[notice]},1,'reschedule');assert.equal(res.status,200);const outsider=await read('other');assert.doesNotMatch(JSON.stringify(outsider),/Private Title|Secret Agenda|example\.test\/secret/);assert.equal(outsider.state.notices[0].title,'排程異動');}finally{f.close()}});


test('role downgrade between authentication and workspace read does not expose private meetings',async()=>{const f=fixture();try{f.beforeRead(()=>f.db.prepare("UPDATE members SET role='member' WHERE user_id='admin-kao19950411'").run());as('admin');const res=await GET();assert.ok(res.status===200||res.status===401||res.status===403);const body=await res.json();assert.doesNotMatch(JSON.stringify(body),/Private Title|Secret Agenda|example\.test\/secret/);}finally{f.close()}});


test('role downgrade between permission check and batch blocks all writes',async()=>{const f=fixture();try{const before=await read('admin');const revised=before.state.meetings.map(m=>m.id==='private'?{...m,agenda:'Unauthorised'}:m);f.beforeBatch(()=>f.db.prepare("UPDATE members SET role='member' WHERE user_id='admin-kao19950411'").run());const res=await put('admin',{...before.state,meetings:revised},1,'edit_meeting');assert.equal(res.status,403);assert.equal(f.db.prepare('SELECT version FROM workspace_states WHERE id=1').get().version,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM audit_logs').get().n,0);assert.equal(JSON.parse(f.db.prepare("SELECT data FROM meetings WHERE id='private'").get().data).agenda,'Secret Agenda');}finally{f.close()}});

test('session revocation during write blocks all writes',async()=>{const f=fixture();try{const before=await read('admin');const revised=before.state.meetings.map(m=>m.id==='private'?{...m,agenda:'Unauthorised'}:m);f.beforeBatch(()=>f.db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(hashes(tokens.admin)));const res=await put('admin',{...before.state,meetings:revised},1,'edit_meeting');assert.equal(res.status,401);assert.equal(f.db.prepare('SELECT version FROM workspace_states WHERE id=1').get().version,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM audit_logs').get().n,0);}finally{f.close()}});

test('malformed or duplicate invite lists fail closed despite containing the caller',async()=>{
  for(const bad of [['invite',123],['invite','invite'],['invite','  '],['invite',' coord']]){
    const f=fixture();try{
      const malformed={...f.org,invitedMemberIds:bad};
      f.db.prepare("UPDATE meetings SET data=? WHERE id='private'").run(JSON.stringify(malformed));
      const view=await read('invite');
      assert.deepEqual(view.state.meetings.map(m=>m.id),['old']);
      const response=await put('invite',view.state,1,'update_workspace');
      assert.equal(response.status,200,'an unseen unchanged malformed row must not block unrelated valid work');
      assert.deepEqual(JSON.parse(f.db.prepare("SELECT data FROM meetings WHERE id='private'").get().data),malformed);
    }finally{f.close()}
  }
});

test('physical NULL or empty activity without scope stays private and survives unrelated new meeting exactly',async()=>{
  const cases=[
    {activityId:'', invitedMemberIds:['coord']},
    {activityId:'contradictory', invitedMemberIds:['coord']},
    {activityId:'', meetingScope:'other', invitedMemberIds:['coord']},
  ];
  for(const fields of cases){const f=fixture();try{
    const raw=JSON.stringify({id:'private',title:'Private Title',time:'2026-12-01T09:00',status:'待確認',agenda:'Secret Agenda',...fields},null,2);
    f.db.prepare("UPDATE meetings SET activity_id=NULL,data=? WHERE id='private'").run(raw);
    const view=await read('coord');
    assert.deepEqual(view.state.meetings.map(m=>m.id),['old']);
    const created={id:'new',title:'New',activityId:'',meetingScope:'organization',invitedMemberIds:['coord'],time:'2026-12-02T09:00',status:'待確認'};
    const response=await put('coord',{...view.state,meetings:[...view.state.meetings,created]},1,'create_meeting');
    assert.equal(response.status,200);
    const original=f.db.prepare("SELECT activity_id,data,position FROM meetings WHERE id='private'").get();
    assert.equal(original.activity_id,null);assert.equal(original.data,raw);assert.equal(original.position,1);
    assert.doesNotMatch(JSON.stringify(await read('coord')),/Private Title|Secret Agenda/);
  }finally{f.close()}}
});

test('manager can inspect and repair corrupt private record without unrelated writes altering its original bytes',async()=>{const f=fixture();try{
  const raw=JSON.stringify({id:'private',title:'Private Title',activityId:'wrong',invitedMemberIds:['invite',17],time:'2026-12-01T09:00',status:'待確認',agenda:'Secret Agenda'},null,2);
  f.db.prepare("UPDATE meetings SET activity_id=NULL,data=? WHERE id='private'").run(raw);
  const admin=await read('admin');const privateRow=admin.state.meetings.find(m=>m.id==='private');
  assert.equal(privateRow.meetingScope,'organization');assert.equal(privateRow.activityId,'');assert.deepEqual(privateRow.invitedMemberIds,[]);
  assert.equal((await put('admin',admin.state,1,'update_workspace')).status,200);
  assert.equal(f.db.prepare("SELECT data FROM meetings WHERE id='private'").get().data,raw);
  const current=await read('admin');const corrected=current.state.meetings.map(m=>m.id==='private'?{...m,invitedMemberIds:['invite']}:m);
  assert.equal((await put('admin',{...current.state,meetings:corrected},2,'edit_meeting')).status,200);
  assert.ok((await read('invite')).state.meetings.some(m=>m.id==='private'));
  assert.doesNotMatch(JSON.stringify(await read('other')),/Private Title|Secret Agenda/);
}finally{f.close()}});

test('mismatched activity fields or private metadata without scope never become public',async()=>{
  const cases=[
    {physical:'stored-activity', fields:{activityId:'other-activity',invitedMemberIds:['coord']}},
    {physical:'stored-activity', fields:{activityId:'stored-activity',invitedMemberIds:['coord']}},
    {physical:'stored-activity', fields:{activityId:'other-activity',meetingScope:'organization',invitedMemberIds:['coord']}},
  ];
  for(const {physical,fields} of cases){const f=fixture();try{
    const raw=JSON.stringify({id:'private',title:'Private Title',time:'2026-12-01T09:00',status:'待確認',agenda:'Secret Agenda',...fields},null,2);
    f.db.prepare("UPDATE meetings SET activity_id=?,data=? WHERE id='private'").run(physical,raw);
    const view=await read('coord');assert.deepEqual(view.state.meetings.map(m=>m.id),['old']);
    const created={id:'new',title:'New',activityId:'',meetingScope:'organization',invitedMemberIds:['coord'],time:'2026-12-02T09:00',status:'待確認'};
    assert.equal((await put('coord',{...view.state,meetings:[...view.state.meetings,created]},1,'create_meeting')).status,200);
    const original=f.db.prepare("SELECT activity_id,data,position FROM meetings WHERE id='private'").get();
    assert.equal(original.activity_id,physical);assert.equal(original.data,raw);assert.equal(original.position,1);
    assert.doesNotMatch(JSON.stringify(await read('coord')),/Private Title|Secret Agenda/);
    const admin=await read('admin');const repaired=admin.state.meetings.find(m=>m.id==='private');assert.equal(repaired.meetingScope,'organization');assert.equal(repaired.activityId,'');
    const edited=admin.state.meetings.map(m=>m.id==='private'?{...m,invitedMemberIds:['invite']}:m);
    assert.equal((await put('admin',{...admin.state,meetings:edited},2,'edit_meeting')).status,200);
    assert.ok((await read('invite')).state.meetings.some(m=>m.id==='private'));
    assert.doesNotMatch(JSON.stringify(await read('other')),/Private Title|Secret Agenda/);
  }finally{f.close()}}
});

test('session expiring after precheck but before DB batch cannot mutate data or audit',async()=>{const f=fixture();try{
  const before=await read('admin');const beforeRows=f.db.prepare('SELECT id,activity_id,position,data FROM meetings ORDER BY position').all().map(r=>({...r}));
  const revised=before.state.meetings.map(m=>m.id==='private'?{...m,agenda:'Unauthorised'}:m);
  f.beforeBatch(()=>{const expires=Date.now()+15;f.db.prepare('UPDATE admin_sessions SET expires_at=? WHERE token_hash=?').run(expires,hashes(tokens.admin));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50)});
  const res=await put('admin',{...before.state,meetings:revised},1,'edit_meeting');assert.equal(res.status,401);
  assert.equal(f.db.prepare('SELECT version FROM workspace_states WHERE id=1').get().version,1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM audit_logs').get().n,0);
  assert.deepEqual(f.db.prepare('SELECT id,activity_id,position,data FROM meetings ORDER BY position').all().map(r=>({...r})),beforeRows);
}finally{f.close()}});


test('session expiring between batch statements cannot produce an orphan audit',async()=>{const f=fixture();try{
  const before=await read('admin');const revised=before.state.meetings.map(m=>m.id==='private'?{...m,agenda:'Updated'}:m);
  f.beforeBatch(()=>f.db.prepare('UPDATE admin_sessions SET expires_at=? WHERE token_hash=?').run(Date.now()+40,hashes(tokens.admin)));
  f.afterFirst(()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,80));
  const res=await put('admin',{...before.state,meetings:revised},1,'edit_meeting');assert.equal(res.status,200);
  const receipt=await res.json();assert.equal(receipt.saved,true);assert.equal(receipt.requiresReauthentication,true);assert.equal(receipt.version,2);assert.ok(!('state' in receipt));assert.doesNotMatch(JSON.stringify(receipt),/Private Title|Secret Agenda/);
  assert.equal(f.db.prepare('SELECT version FROM workspace_states WHERE id=1').get().version,2);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM audit_logs').get().n,1);
  assert.equal(JSON.parse(f.db.prepare("SELECT data FROM meetings WHERE id='private'").get().data).agenda,'Updated');
  const oldToken=tokens.admin;const fresh='e'.repeat(64);tokens.admin=fresh;
  try{f.db.prepare('INSERT INTO admin_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hashes(fresh),'admin-kao19950411',Date.now()+60000);
    const retry=await put('admin',{...before.state,meetings:revised},1,'edit_meeting');assert.equal(retry.status,409);
    assert.equal(f.db.prepare('SELECT version FROM workspace_states WHERE id=1').get().version,2);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM audit_logs').get().n,1);
  }finally{tokens.admin=oldToken;}
}finally{f.close()}});


test('committed write returns a safe receipt if the post-commit snapshot read fails',async()=>{const f=fixture();try{
  const before=await read('admin');const revised=before.state.meetings.map(m=>m.id==='private'?{...m,agenda:'Updated'}:m);
  f.afterFirst(()=>f.beforeRead(()=>{throw new Error('injected snapshot failure')}));
  const res=await put('admin',{...before.state,meetings:revised},1,'edit_meeting');assert.equal(res.status,200);
  const receipt=await res.json();assert.equal(receipt.saved,true);assert.equal(receipt.requiresReauthentication,true);assert.ok(!('state' in receipt));
  assert.equal(f.db.prepare('SELECT version FROM workspace_states WHERE id=1').get().version,2);assert.equal(f.db.prepare('SELECT count(*) AS n FROM audit_logs').get().n,1);
  assert.equal(JSON.parse(f.db.prepare("SELECT data FROM meetings WHERE id='private'").get().data).agenda,'Updated');
}finally{f.close()}});

test('DB millisecond expiry expression preserves exact equality and boundaries',()=>{
  const src=readFileSync('app/api/workspace/route.ts','utf8');
  const match=src.match(/const databaseNowMs = "([^"]+)"/);assert.ok(match);
  const fixed=match[1].replaceAll("'now'",'?');const db=new DatabaseSync(':memory:');
  try{
    const clock=db.prepare(`SELECT ${fixed} AS now_ms`);
    const guard=db.prepare(`SELECT ? > ${fixed} AS valid`);
    for(const base of ['2026-11-14T13:11:51','2026-11-14T13:11:59','2026-11-14T23:59:59']){
      for(let ms=0;ms<1000;ms++){
        const timestamp=`${base}.${String(ms).padStart(3,'0')}Z`;const expected=Date.parse(timestamp);
        assert.equal(clock.get(timestamp,timestamp).now_ms,expected);
        for(const [expiry,valid] of [[expected-1,0],[expected,0],[expected+1,1]]) assert.equal(guard.get(expiry,timestamp,timestamp).valid,valid);
      }
    }
  }finally{db.close()}
});
