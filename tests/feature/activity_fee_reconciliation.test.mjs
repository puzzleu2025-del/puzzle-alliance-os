import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

globalThis.__feeEnv = {};
globalThis.__feeUser = { userId:'mgr',role:'manager',displayName:'Manager' };
const token='a'.repeat(64);
const auth=`export const getMember=async()=>globalThis.__feeUser;export const currentToken=async()=>"${token}";export const tokenHash=async()=>"sessionhash";export const randomToken=()=>"b".repeat(64);export const csrfError=r=>r.headers.get('origin')===new URL(r.url).origin?null:new Response(null,{status:403});`;
registerHooks({resolve(s,c,next){if(s==='cloudflare:workers')return {url:'data:text/javascript,export const env=globalThis.__feeEnv',shortCircuit:true};if(s==='@/app/admin-auth')return {url:'data:text/javascript,'+encodeURIComponent(auth),shortCircuit:true};if(s==='@/app/task-deadlines')return {url:'data:text/javascript,export const taskDeadlineError=()=>""',shortCircuit:true};if(s==='@/app/registration-types')return {url:pathToFileURL(process.cwd()+'/app/registration-types.ts').href,shortCircuit:true};return next(s,c)}});
const workspaceApi=await import('../../app/api/workspace/route.ts');
const formsApi=await import('../../app/api/registration-forms/route.ts');
const activity=(feeAmount=0)=>({id:'a',name:'A',date:'2026-12-01',owner:'Lead',status:'planning',description:'',coordinatorIds:['coord'],feeAmount});
const state=(amount=0)=>({activities:[activity(amount)],tasks:[],meetings:[],notices:[]});
function setup(){
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');for(const f of readdirSync('drizzle').filter(n=>/^[0-9]{4}_.*\.sql$/.test(n)).sort())db.exec(readFileSync('drizzle/'+f,'utf8'));
  db.exec(`INSERT INTO members(user_id,username,email,display_name,role,status,created_at) VALUES ('mgr','manager1','','Manager','manager','active','2026'),('coord','coordinator1','','Lead','coordinator','active','2026'),('person','person1','','Person','member','active','2026'); INSERT INTO admin_sessions(token_hash,user_id,expires_at) VALUES ('sessionhash','mgr',4102444800000);`);
  db.prepare('INSERT INTO workspace_states(id,data,version,updated_at,updated_by) VALUES(1,?,5,?,?)').run(JSON.stringify(state()),'2026','mgr');
  db.prepare("INSERT INTO registration_forms(id,activity_id,slug,title,description,status,schema_json,privacy_notice,version,created_by,created_at,updated_at) VALUES('form','a','slug','Title','','open','{}','notice',1,'mgr','2026','2026')").run();
  for(const [id,payment] of [['unpaid','not_required'],['paid','paid'],['refund','refunded'],['cancel','not_required']]) db.prepare("INSERT INTO registration_submissions(id,form_id,form_version,schema_json,answers_json,consent,payment_status,idempotency_hash,source_hash,submitted_at) VALUES(?,'form',1,'[]','{}',1,?,?,'source','2026')").run(id,payment,id);
  db.exec("INSERT INTO registration_identities(submission_id,form_id,member_id,status) VALUES('cancel','form','person','cancelled')");
  function statement(sql,values=[]){return{sql,values,bind(...args){return statement(sql,args)},async first(){const row=db.prepare(sql).get(...values);return row?{...row}:null},async all(){return{success:true,results:db.prepare(sql).all(...values).map(r=>({...r}))}},async run(){return{success:true,meta:{changes:Number(db.prepare(sql).run(...values).changes)}}}}}
  globalThis.__feeEnv.DB={prepare:s=>statement(s),async batch(statements){db.exec('BEGIN IMMEDIATE');try{const result=statements.map(s=>({success:true,meta:{changes:Number(db.prepare(s.sql).run(...s.values).changes)}}));db.exec('COMMIT');return result}catch(e){db.exec('ROLLBACK');throw e}}};
  globalThis.__feeUser={userId:'mgr',role:'manager',displayName:'Manager'};return db;
}
const request=(body)=>new Request('https://local.test/api/workspace',{method:'PUT',headers:{origin:'https://local.test','content-type':'application/json'},body:JSON.stringify(body)});
const patch=(body)=>new Request('https://local.test/api/registration-forms',{method:'PATCH',headers:{origin:'https://local.test','content-type':'application/json'},body:JSON.stringify(body)});
const row=(db,id)=>db.prepare('SELECT payment_status,fee_followup,fee_recheck_reason FROM registration_submissions WHERE id=?').get(id);

test('free to paid updates only eligible registrations and stale workspace CAS cannot change price',async()=>{const db=setup();try{
  let result=await workspaceApi.PUT(request({state:state(100),version:5,action:'edit_activity'}));assert.equal(result.status,200);
  assert.deepEqual({...db.prepare("SELECT amount,revision FROM activity_fees WHERE activity_id='a'").get()},{amount:100,revision:1});
  assert.deepEqual({...row(db,'unpaid')},{payment_status:'unpaid',fee_followup:1,fee_recheck_reason:''});
  assert.deepEqual({...row(db,'paid')},{payment_status:'paid',fee_followup:0,fee_recheck_reason:'price_change'});
  assert.equal(row(db,'refund').payment_status,'refunded');assert.equal(row(db,'cancel').payment_status,'not_required');
  result=await workspaceApi.PUT(request({state:state(200),version:5,action:'edit_activity'}));assert.equal(result.status,409);assert.equal(db.prepare("SELECT amount FROM activity_fees WHERE activity_id='a'").get().amount,100);
}finally{db.close()}});

test('paid to free marks paid for refund and unpaid as not required',async()=>{const db=setup();try{
  assert.equal((await workspaceApi.PUT(request({state:state(100),version:5,action:'edit_activity'}))).status,200);
  db.exec("UPDATE registration_submissions SET payment_status='checking' WHERE id='unpaid'");
  assert.equal((await workspaceApi.PUT(request({state:state(0),version:6,action:'edit_activity'}))).status,200);
  assert.deepEqual({...row(db,'paid')},{payment_status:'paid',fee_followup:0,fee_recheck_reason:'refund'});
  assert.deepEqual({...row(db,'unpaid')},{payment_status:'not_required',fee_followup:0,fee_recheck_reason:''});
}finally{db.close()}});

test('old fee revision cannot reconcile after a price change; manager must resolve refunds explicitly',async()=>{const db=setup();try{
  assert.equal((await workspaceApi.PUT(request({state:state(100),version:5,action:'edit_activity'}))).status,200);
  let result=await formsApi.PATCH(patch({formId:'form',submissionId:'unpaid',paymentStatus:'paid',paymentNote:'',feeRevision:0}));assert.equal(result.status,409);assert.equal(row(db,'unpaid').payment_status,'unpaid');
  result=await formsApi.PATCH(patch({formId:'form',submissionId:'unpaid',paymentStatus:'paid',paymentNote:'',feeRevision:1}));assert.equal(result.status,200);
  assert.equal((await workspaceApi.PUT(request({state:state(0),version:6,action:'edit_activity'}))).status,200);
  result=await formsApi.PATCH(patch({formId:'form',submissionId:'unpaid',paymentStatus:'paid',paymentNote:'',feeRevision:2,resolveRecheck:true}));assert.equal(result.status,409);assert.equal(row(db,'unpaid').fee_recheck_reason,'refund');
  result=await formsApi.PATCH(patch({formId:'form',submissionId:'unpaid',paymentStatus:'refunded',paymentNote:'',feeRevision:2,resolveRecheck:true}));assert.equal(result.status,200);assert.equal(row(db,'unpaid').fee_recheck_reason,'');
}finally{db.close()}});

test('invalid and unauthorised prices do not mutate state',async()=>{const db=setup();try{
 for(const value of [-1,1.5,Number.MAX_SAFE_INTEGER+1]) assert.equal((await workspaceApi.PUT(request({state:state(value),version:5,action:'edit_activity'}))).status,400);
 db.exec("UPDATE admin_sessions SET user_id='person' WHERE token_hash='sessionhash'");globalThis.__feeUser={userId:'person',role:'member',displayName:'Person'};assert.equal((await workspaceApi.PUT(request({state:state(100),version:5,action:'edit_activity'}))).status,403);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM activity_fees').get().n,0);
}finally{db.close()}});
