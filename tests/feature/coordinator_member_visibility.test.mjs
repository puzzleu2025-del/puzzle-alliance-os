import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

globalThis.__visibilityEnv = {};
globalThis.__visibilityHeaders = new Headers();
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export const env=globalThis.__visibilityEnv', shortCircuit: true };
  if (specifier === 'next/headers') return { url: 'data:text/javascript,export async function headers(){return globalThis.__visibilityHeaders}', shortCircuit: true };
  if (specifier === '@/app/admin-auth') return { url: pathToFileURL(path.resolve('app/admin-auth.ts')).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { GET, PATCH, POST } = await import('../../app/api/members/route.ts');
const env = globalThis.__visibilityEnv;
const token = 'c'.repeat(64), adminToken = 'a'.repeat(64);
const hash = t => createHash('sha256').update(t).digest('hex');
const origin = 'https://puzzle.example';

function fixture(filename = ':memory:') {
  const sqlite = new DatabaseSync(filename); sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
  for (const file of readdirSync('drizzle').filter(n => /^[0-9]{4}_.*\.sql$/.test(n)).sort()) sqlite.exec(readFileSync('drizzle/'+file,'utf8'));
  const add = sqlite.prepare('INSERT INTO members (user_id,username,email,display_name,phone,role,status,created_at) VALUES (?,?,?,?,?,?,?,?)');
  for (const [id,name,role,status] of [['coord','Lead','coordinator','active'],['pending','Pending','member','pending'],['own','Member A','member','active'],['other','Member B','member','active'],['higher','Higher','manager','active'],['cancelled','Cancel','member','active'],['legacy','Legacy','member','active'],['malformed','Malformed','member','active']]) add.run(id,id+'123','same@example.test',name,'0987654321',role,status,'2026');
  const session = sqlite.prepare('INSERT INTO admin_sessions(token_hash,user_id,expires_at) VALUES (?,?,?)');
  session.run(hash(token),'coord',Date.now()+60000); session.run(hash(adminToken),'admin-kao19950411',Date.now()+60000);
  const state = {activities:[{id:'a',coordinatorIds:['coord']},{id:'b',coordinatorIds:[]},{id:'c',owner:'Lead'},{id:'bad',coordinatorIds:'coord',owner:'Lead'}],tasks:[],meetings:[],notices:[]};
  sqlite.prepare('INSERT INTO workspace_states(id,data,version,updated_at,updated_by) VALUES(1,?,1,?,?)').run(JSON.stringify(state),'2026','coord');
  for (const [a,member,status] of [['a','own','active'],['a','higher','active'],['a','cancelled','cancelled'],['b','other','active'],['c','legacy','active'],['bad','malformed','active']]) {
    sqlite.prepare('INSERT OR IGNORE INTO registration_forms(id,activity_id,slug,title,description,status,schema_json,privacy_notice,version,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('form'+a,a,'slug'+a,'t','','open','{}','',1,'coord','2026','2026');
    sqlite.prepare('INSERT INTO registration_submissions(id,form_id,form_version,schema_json,answers_json,consent,idempotency_hash,source_hash,submitted_at) VALUES(?,?,?,?,?,?,?,?,?)').run('sub'+member,'form'+a,1,'{}','{}',1,'h'+member,'s','2026');
    sqlite.prepare('INSERT INTO registration_identities(submission_id,form_id,member_id,status) VALUES(?,?,?,?)').run('sub'+member,'form'+a,member,status);
  }
  function stmt(sql,values=[]) { return {sql,values,bind(...args){return stmt(sql,args)},async first(){const r=sqlite.prepare(sql).get(...values);return r?{...r}:null},async all(){return {results:sqlite.prepare(sql).all(...values).map(r=>({...r}))}},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}}}}; }
  let injectRace = false;
  env.DB={prepare:sql=>stmt(injectRace && sql.includes('WITH source AS') ? sql.replace('json_valid(data)', 'json_valid(data) AND race_probe()') : sql),async batch(statements){sqlite.exec('BEGIN');try{const r=statements.map(s=>({meta:{changes:Number(sqlite.prepare(s.sql).run(...s.values).changes)}}));sqlite.exec('COMMIT');return r}catch(e){sqlite.exec('ROLLBACK');throw e}}};
  globalThis.__visibilityHeaders=new Headers({cookie:`puzzle_admin_session=${token}`});
  return {sqlite,state,enableRace(){ injectRace=true; },close(){delete env.DB;sqlite.close()}};
}
const ids = async response => (await response.json()).members.map(m=>m.id).sort();
const patch = body => PATCH(new Request(origin+'/api/members',{method:'PATCH',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)}));

test('coordinator sees pending and granted activity identities only, including higher roles',async()=>{const f=fixture();try{
  assert.deepEqual(await ids(await GET()),['coord','higher','legacy','own','pending']);
  globalThis.__visibilityHeaders=new Headers({cookie:`puzzle_admin_session=${adminToken}`});
  const admin=await ids(await GET()); assert.ok(admin.includes('other'));assert.ok(admin.includes('cancelled'));
}finally{f.close()}});

test('empty grant, revocation, corrupt workspace and duplicate legacy name fail closed',async()=>{const f=fixture();try{
  f.state.activities[0].coordinatorIds=[];
  f.sqlite.prepare('UPDATE workspace_states SET data=? WHERE id=1').run(JSON.stringify(f.state));
  assert.deepEqual(await ids(await GET()),['coord','legacy','pending']);
  f.sqlite.prepare("INSERT INTO members(user_id,username,email,display_name,role,status,created_at) VALUES('duplicate','duplicate','same@example.test','Lead','member','active','2026')").run();
  assert.deepEqual(await ids(await GET()),['coord','pending']);
  f.sqlite.prepare("UPDATE workspace_states SET data='invalid' WHERE id=1").run();
  assert.deepEqual(await ids(await GET()),['coord','pending']);
}finally{f.close()}});

test('direct PATCH retains valid management operations without returning hidden personal data',async()=>{const f=fixture();try{
  const hidden=await patch({id:'other',role:'member'});assert.equal(hidden.status,200);
  const body=await hidden.json(); assert.ok(!JSON.stringify(body).includes('Member B'));assert.ok(!JSON.stringify(body).includes('other123')); assert.ok(!body.members.some(m=>m.id==='other'));
  const approval=await patch({id:'pending',status:'active'});assert.equal(approval.status,200); const approved=await approval.json(); assert.ok(!approved.members.some(m=>m.id==='pending'));
  assert.equal(f.sqlite.prepare("SELECT status FROM members WHERE user_id='pending'").get().status,'active');
}finally{f.close()}});

test('hidden member cannot be made visible by changing their status to pending',async()=>{const f=fixture();try{
  const response=await patch({id:'other',status:'pending'});
  assert.notEqual(response.status,200,'a hidden member must not be turned into a newly visible pending applicant');
  assert.ok(!(await ids(await GET())).includes('other'));
}finally{f.close()}});


test('duplicate grant ids and duplicate activity ids fail closed',async()=>{const f=fixture();try{
  f.state.activities[0].coordinatorIds=['coord','coord'];
  f.sqlite.prepare('UPDATE workspace_states SET data=? WHERE id=1').run(JSON.stringify(f.state));
  assert.deepEqual(await ids(await GET()),['coord','legacy','pending']);
  f.state.activities[0].coordinatorIds=['coord']; f.state.activities.push({id:'a',coordinatorIds:[]});
  f.sqlite.prepare('UPDATE workspace_states SET data=? WHERE id=1').run(JSON.stringify(f.state));
  assert.deepEqual(await ids(await GET()),['coord','legacy','pending']);
}finally{f.close()}});

test('create response returns refreshed visible list for coordinator',async()=>{const f=fixture();try{
  const req = status => new Request(origin+'/api/members',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username:'new'+status,displayName:'Created',role:'member',status,password:'Testpass-123'})});
  let response=await POST(req('active')); assert.equal(response.status,201); let body=await response.json();assert.ok(Array.isArray(body.members));assert.ok(!body.members.some(m=>m.username==='newactive'));
  response=await POST(req('pending')); assert.equal(response.status,201);body=await response.json(); assert.ok(body.members.some(m=>m.username==='newpending'));
}finally{f.close()}});

test('revocation racing a newly registered member cannot combine two snapshots',async()=>{
  const temp=mkdtempSync(path.join(os.tmpdir(),'puzzle-visibility-')); const filename=path.join(temp,'race.sqlite');const f=fixture(filename);const otherDb=new DatabaseSync(filename);otherDb.exec('PRAGMA foreign_keys=ON');let fired=0;
  try {
    f.sqlite.function('race_probe',()=>{
      if (fired++) return 1;
      const next=structuredClone(f.state); next.activities[0].coordinatorIds=[];
      otherDb.exec('BEGIN IMMEDIATE');
      otherDb.prepare('UPDATE workspace_states SET data=? WHERE id=1').run(JSON.stringify(next));
      otherDb.prepare("INSERT INTO registration_submissions(id,form_id,form_version,schema_json,answers_json,consent,idempotency_hash,source_hash,submitted_at) VALUES('race-sub','forma',1,'{}','{}',1,'race-id','s','2026')").run();
      otherDb.prepare("INSERT INTO registration_identities(submission_id,form_id,member_id,status) VALUES('race-sub','forma','other','active')").run();
      otherDb.exec('COMMIT'); return 1;
    });
    f.enableRace();const observed=await ids(await GET());assert.ok(fired>0);assert.ok(!observed.includes('other'),'new identity must not pair with the old grant');
    const after=await ids(await GET());assert.ok(!after.includes('own'));assert.ok(!after.includes('other'));assert.ok(after.includes('pending'));
  }finally{otherDb.close();f.close();if(path.dirname(temp)===os.tmpdir() && path.basename(temp).startsWith('puzzle-visibility-'))rmSync(temp,{recursive:true,force:true});}
});

test('hidden rejected application can be restored by admin while visible rejected application stays manageable',async()=>{const f=fixture();try{
  f.sqlite.prepare("UPDATE members SET status='rejected' WHERE user_id IN ('other','own')").run();
  let response=await patch({id:'other',status:'pending'}); assert.equal(response.status,403);
  assert.equal(f.sqlite.prepare("SELECT status FROM members WHERE user_id='other'").get().status,'rejected');
  response=await patch({id:'own',status:'pending'}); assert.equal(response.status,200);
  assert.equal(f.sqlite.prepare("SELECT status FROM members WHERE user_id='own'").get().status,'pending');
  globalThis.__visibilityHeaders=new Headers({cookie:`puzzle_admin_session=${adminToken}`});
  response=await patch({id:'other',status:'pending'}); assert.equal(response.status,200);
  assert.equal(f.sqlite.prepare("SELECT status FROM members WHERE user_id='other'").get().status,'pending');
}finally{f.close()}});

test('revoking grant during pending change aborts whole batch including password and audit',async()=>{const f=fixture();try{
  f.sqlite.prepare("UPDATE members SET status='rejected' WHERE user_id='own'").run();
  const oldBatch=env.DB.batch; env.DB.batch=async statements=>{
    f.state.activities[0].coordinatorIds=[];
    f.sqlite.prepare('UPDATE workspace_states SET data=? WHERE id=1').run(JSON.stringify(f.state));
    return oldBatch(statements);
  };
  const countBefore=f.sqlite.prepare('SELECT count(*) n FROM audit_logs').get().n;
  const response=await patch({id:'own',status:'pending',newPassword:'new-password-123'});assert.equal(response.status,503);
  assert.equal(f.sqlite.prepare("SELECT status FROM members WHERE user_id='own'").get().status,'rejected');
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM admin_credentials WHERE user_id='own'").get().n,0);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM audit_logs').get().n,countBefore);
}finally{f.close()}});

test('numeric and empty activity ids cannot authorize matching text ids in the database',async()=>{const f=fixture();try{
  const add=f.sqlite.prepare('INSERT INTO members(user_id,username,email,display_name,role,status,created_at) VALUES(?,?,?,?,?,?,?)');
  for(const [id,activity] of [['numeric','123'],['empty','']]) {
    add.run(id,id+'123','same@example.test',id,'member','active','2026');
    f.sqlite.prepare('INSERT INTO registration_forms(id,activity_id,slug,title,description,status,schema_json,privacy_notice,version,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('form-'+id,activity,'slug-'+id,'t','','open','{}','',1,'coord','2026','2026');
    f.sqlite.prepare('INSERT INTO registration_submissions(id,form_id,form_version,schema_json,answers_json,consent,idempotency_hash,source_hash,submitted_at) VALUES(?,?,?,?,?,?,?,?,?)').run('sub-'+id,'form-'+id,1,'{}','{}',1,'hash-'+id,'s','2026');
    f.sqlite.prepare('INSERT INTO registration_identities(submission_id,form_id,member_id,status) VALUES(?,?,?,?)').run('sub-'+id,'form-'+id,id,'active');
  }
  f.state.activities.push({id:123,coordinatorIds:['coord']},{id:'',coordinatorIds:['coord']});
  f.sqlite.prepare('UPDATE workspace_states SET data=? WHERE id=1').run(JSON.stringify(f.state));
  const actual=await ids(await GET()); assert.ok(!actual.includes('numeric'));assert.ok(!actual.includes('empty'));assert.ok(actual.includes('own'));
}finally{f.close()}});

test('legacy grant trims ECMAScript Unicode whitespace but does not trim zero-width non-whitespace',async()=>{const f=fixture();try{
  const update=()=>f.sqlite.prepare('UPDATE workspace_states SET data=? WHERE id=1').run(JSON.stringify(f.state));
  const chars=['\u0009','\u000a','\u000b','\u000c','\u000d','\u0020','\u00a0','\u1680','\u2000','\u2001','\u2002','\u2003','\u2004','\u2005','\u2006','\u2007','\u2008','\u2009','\u200a','\u2028','\u2029','\u202f','\u205f','\u3000','\ufeff'];
  for(const ch of chars){f.state.activities[2].owner=ch+'Lead'+ch;update();assert.ok((await ids(await GET())).includes('legacy'),`legacy owner should trim U+${ch.codePointAt(0).toString(16)}`);}
  f.state.activities[2].owner='\u200bLead\u200b';update();assert.ok(!(await ids(await GET())).includes('legacy'),'zero-width space must not create a legacy grant');
  f.state.activities[2].owner='Other';f.state.activities[2].proxy='\u3000Lead\u3000';update();assert.ok((await ids(await GET())).includes('legacy'),'proxy follows the same trim rule');
  f.sqlite.prepare("INSERT INTO members(user_id,username,email,display_name,role,status,created_at) VALUES('duplicate2','duplicate2','same@example.test','Lead','member','active','2026')").run();
  assert.ok(!(await ids(await GET())).includes('legacy'),'trimmed legacy grant still rejects ambiguous active names');
}finally{f.close()}});
