#!/usr/bin/env python3
"""ARGO Codex local coordination ledger.
Does not spawn agents. Enforces atomic claims, dependency readiness, writer ownership,
and independent acceptance for pass verdicts.
"""
from pathlib import Path
import argparse, json, os, sys, datetime, tempfile

def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()

def dirs(root):
    base=root/'.argo'
    for x in ['tasks','claims','receipts','acceptance']:(base/x).mkdir(parents=True,exist_ok=True)
    return base

def load(p): return json.loads(p.read_text(encoding='utf-8'))
def save_atomic(p,obj):
    p.parent.mkdir(parents=True,exist_ok=True)
    fd,tmp=tempfile.mkstemp(dir=p.parent,prefix=p.name+'.',suffix='.tmp')
    try:
        with os.fdopen(fd,'w',encoding='utf-8') as f: json.dump(obj,f,ensure_ascii=False,indent=2)
        os.replace(tmp,p)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def task_path(base,tid): return base/'tasks'/f'{tid}.json'
def claim_path(base,tid): return base/'claims'/f'{tid}.json'

def require_dependencies_accepted(base,task):
    for dep in task.get('dependencies',[]):
        dp=task_path(base,dep)
        if not dp.exists(): sys.exit('DEPENDENCY_NOT_FOUND='+dep)
        st=load(dp).get('status')
        if st!='ACCEPTED': sys.exit(f'DEPENDENCY_NOT_ACCEPTED={dep}:{st}')

def active_write_conflict(base,task):
    wanted=set(task.get('write_set') or [])
    if not wanted:return None
    for cp in (base/'claims').glob('*.json'):
        c=load(cp); other=c.get('task_id')
        if other==task.get('task_id'): continue
        tp=task_path(base,other)
        if not tp.exists(): continue
        ot=load(tp)
        if ot.get('status') not in {'IN_PROGRESS','READY_FOR_ACCEPTANCE'}: continue
        overlap=wanted.intersection(set(ot.get('write_set') or []))
        if overlap:return other,sorted(overlap)
    return None

def create(a):
    root=Path(a.root).resolve(); base=dirs(root); p=task_path(base,a.task_id)
    if p.exists(): sys.exit('TASK_EXISTS')
    obj={'task_id':a.task_id,'project_id':a.project_id,'role':a.role,'owner':a.owner,'objective':a.objective,
         'read_set':a.read or [],'write_set':a.write or [],'dependencies':a.depends or [],'acceptance':a.accept or [],
         'status':'PENDING','created_at':now(),'updated_at':now()}
    save_atomic(p,obj); print(p)

def claim(a):
    root=Path(a.root).resolve(); base=dirs(root); taskp=task_path(base,a.task_id)
    if not taskp.exists(): sys.exit('TASK_NOT_FOUND')
    task=load(taskp)
    if task.get('owner') and a.worker!=task.get('owner'): sys.exit('CLAIMANT_NOT_TASK_OWNER')
    require_dependencies_accepted(base,task)
    conflict=active_write_conflict(base,task)
    if conflict: sys.exit('WRITE_SET_CONFLICT='+conflict[0]+':'+','.join(conflict[1]))
    claimp=claim_path(base,a.task_id)
    payload=json.dumps({'task_id':a.task_id,'claimed_by':a.worker,'context':a.context,'claimed_at':now()},ensure_ascii=False,indent=2).encode()
    try: fd=os.open(claimp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o644)
    except FileExistsError:
        existing=load(claimp); sys.exit('ALREADY_CLAIMED_BY='+str(existing.get('claimed_by')))
    with os.fdopen(fd,'wb') as f:f.write(payload)
    task.update(status='IN_PROGRESS',claimed_by=a.worker,context=a.context,updated_at=now()); save_atomic(taskp,task)
    print(claimp)

def ready(a):
    root=Path(a.root).resolve(); base=dirs(root); taskp=task_path(base,a.task_id)
    if not taskp.exists(): sys.exit('TASK_NOT_FOUND')
    if not a.evidence: sys.exit('EVIDENCE_REQUIRED')
    cp=claim_path(base,a.task_id)
    if not cp.exists(): sys.exit('TASK_NOT_CLAIMED')
    claim=load(cp)
    if claim.get('claimed_by')!=a.worker: sys.exit('READY_WORKER_NOT_CLAIMANT')
    task=load(taskp)
    if task.get('status')!='IN_PROGRESS': sys.exit('TASK_NOT_IN_PROGRESS')
    task.update(status='READY_FOR_ACCEPTANCE',updated_at=now()); save_atomic(taskp,task)
    receipt={'task_id':a.task_id,'worker':a.worker,'status':'READY_FOR_ACCEPTANCE','evidence':a.evidence,'notes':a.notes or [],'created_at':now()}
    save_atomic(base/'receipts'/f'{a.task_id}.json',receipt); print(base/'receipts'/f'{a.task_id}.json')

def accept(a):
    root=Path(a.root).resolve(); base=dirs(root); taskp=task_path(base,a.task_id)
    if not taskp.exists(): sys.exit('TASK_NOT_FOUND')
    task=load(taskp)
    if task.get('status')!='READY_FOR_ACCEPTANCE': sys.exit('TASK_NOT_READY')
    cp=claim_path(base,a.task_id)
    claimant=load(cp).get('claimed_by') if cp.exists() else task.get('claimed_by')
    if a.verdict=='pass' and a.verifier==claimant: sys.exit('SELF_ACCEPTANCE_FORBIDDEN')
    if a.verdict=='pass' and not a.evidence: sys.exit('VERIFIER_EVIDENCE_REQUIRED_FOR_PASS')
    verdict='ACCEPTED' if a.verdict=='pass' else 'REJECTED'
    acc={'task_id':a.task_id,'verifier':a.verifier,'verdict':verdict,'evidence':a.evidence or [],'notes':a.notes or [],'created_at':now()}
    save_atomic(base/'acceptance'/f'{a.task_id}.json',acc)
    task.update(status=verdict,updated_at=now()); save_atomic(taskp,task)
    print(base/'acceptance'/f'{a.task_id}.json')

def release(a):
    root=Path(a.root).resolve(); base=dirs(root); p=claim_path(base,a.task_id)
    if not p.exists(): print('NO_CLAIM'); return
    claim=load(p)
    if a.worker and claim.get('claimed_by')!=a.worker: sys.exit('RELEASE_WORKER_NOT_CLAIMANT')
    p.unlink(); print('RELEASED')

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--root',default='.')
    sp=ap.add_subparsers(dest='cmd',required=True)
    x=sp.add_parser('create'); x.add_argument('task_id'); x.add_argument('--project-id',default=''); x.add_argument('--role',required=True); x.add_argument('--owner',required=True); x.add_argument('--objective',required=True); x.add_argument('--read',action='append'); x.add_argument('--write',action='append'); x.add_argument('--depends',action='append'); x.add_argument('--accept',action='append'); x.set_defaults(fn=create)
    x=sp.add_parser('claim'); x.add_argument('task_id'); x.add_argument('--worker',required=True); x.add_argument('--context',default=''); x.set_defaults(fn=claim)
    x=sp.add_parser('ready'); x.add_argument('task_id'); x.add_argument('--worker',required=True); x.add_argument('--evidence',action='append',required=True); x.add_argument('--notes',action='append'); x.set_defaults(fn=ready)
    x=sp.add_parser('accept'); x.add_argument('task_id'); x.add_argument('--verifier',required=True); x.add_argument('--verdict',choices=['pass','fail'],required=True); x.add_argument('--evidence',action='append'); x.add_argument('--notes',action='append'); x.set_defaults(fn=accept)
    x=sp.add_parser('release'); x.add_argument('task_id'); x.add_argument('--worker'); x.set_defaults(fn=release)
    a=ap.parse_args(); a.fn(a)
if __name__=='__main__': main()
