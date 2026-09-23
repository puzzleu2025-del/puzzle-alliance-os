"""Repo adapter for the existing ARGO ledger. Standard library, no model/API calls.
All mutating commands require an explicit task contract. This is a completion/commit
gate, not an OS sandbox and not an authenticated identity service.
"""
import argparse
import datetime as dt
import fnmatch
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from types import SimpleNamespace
import ledger


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def require(ok, message):
    if not ok:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def digest(obj):
    return sha(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode())


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def save(path, obj):
    ledger.save_atomic(path, obj)


def safe(root, relative):
    require(isinstance(relative, str) and relative and "\\" not in relative,
            "INVALID_RELATIVE_PATH")
    p = root / relative
    require(not Path(relative).is_absolute() and ".." not in Path(relative).parts,
            "PATH_ESCAPE")
    require(p.resolve().is_relative_to(root.resolve()), "PATH_ESCAPE")
    q = p
    while q != root:
        require(not q.is_symlink() and not getattr(q, "is_junction", lambda: False)(), "LINKED_PATH")
        q = q.parent
    return p


def git(root, *args):
    return subprocess.check_output(["git", "-c", "safe.directory=" + root.as_posix(),
                                    "-C", str(root), *args])


def snapshot(root):
    tracked = set(git(root, "ls-files", "-z").decode().split("\0")) - {""}
    require(not any(p.startswith(".argo/runtime/") for p in tracked), "TRACKED_RUNTIME_FORBIDDEN")
    paths = tracked | (set(git(root, "ls-files", "--others", "--exclude-standard", "-z").decode().split("\0")) - {""})
    # These ignored control/environment files are still protected. Only hashes,
    # never their contents, are stored in task evidence.
    paths |= {p.relative_to(root).as_posix() for p in root.glob('.env*') if p.is_file()}
    paths |= {x for x in ('.codex/hooks.json', '.codex/config.toml') if (root / x).is_file()}
    result = {}
    for name in sorted(paths):
        if name.startswith(".argo/runtime/"):
            continue
        p = safe(root, name)
        result[name] = {"sha256": sha(p.read_bytes()), "executable": bool(p.stat().st_mode & 0o111)} if p.is_file() else None
    return result


def index_snapshot(root):
    result = {}
    for entry in git(root, 'ls-files', '--stage', '-z').decode().split('\0'):
        if not entry:
            continue
        meta, name = entry.split('\t', 1)
        mode, blob, stage = meta.split()
        require(stage == '0', 'UNMERGED_INDEX:' + name)
        result[name] = {'mode': mode, 'blob': blob}
    return result


def tree(root):
    # Normal staging of already-reviewed bytes does not invalidate tests. The
    # diff gate separately rejects index content differing from the tested tree.
    files = snapshot(root)
    index = index_snapshot(root)
    modes = {name: index.get(name, {}).get('mode', '100755' if os.name != 'nt' and value and value['executable'] else '100644')
             for name, value in files.items()}
    return digest({"head": git(root, "rev-parse", "HEAD").decode().strip(), "files": files, "modes": modes})


def policy(root):
    return read(root / ".argo/policy.json")


def vault(root):
    p = Path(os.environ.get("ARGO_VAULT", policy(root)["vault"])).resolve()
    require(p.is_dir(), "MEMORY_VAULT_UNAVAILABLE")
    require(p.name != "Connections", "CRM_BOUNDARY")
    return p


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    obj = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(obj)
    return obj


def memory_paths(root):
    v = vault(root)
    return v, {k: safe(v, p) for k, p in policy(root)["memory"].items()}


def retrieval(root, feature):
    v, paths = memory_paths(root)
    sm = module(v / "工具/state_memory.py", "argo_state_memory")
    state = json.loads(sm.context(v, policy(root)["project_id"]))
    items = [{"path": str(paths["working"]), "sha256": sha(paths["working"].read_bytes()),
              "content": state}]
    # Always include project protections, corrections and regression lessons; bounded
    # metadata links permit progressive reads instead of loading the whole vault.
    for key in ("specs", "decisions", "regressions", "summary"):
        base = paths[key]
        files = [base] if base.is_file() else sorted(base.glob("*.json")) if base.exists() else []
        for p in files[-8:]:
            content = p.read_text(encoding="utf-8-sig")
            items.append({"kind": key, "path": str(p), "sha256": sha(p.read_bytes()),
                          "content": content[:5000], "truncated": len(content) > 5000})
    packet = {"at": now(), "feature": feature, "project": policy(root)["project_id"], "sources": items}
    return packet


def base(root, ident):
    require(re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,79}", ident) is not None, "INVALID_TASK_ID")
    return root / ".argo/runtime" / ident


def load_task(root, ident):
    p = base(root, ident)
    return p, read(p / "task.json")


def set_task(p, task):
    task["updated_at"] = now()
    save(p / "task.json", task)


def begin(root, ident, feature):
    p = base(root, ident)
    require(not p.exists(), "TASK_EXISTS")
    active_path = root / ".argo/runtime/active.json"
    if active_path.exists():
        _, old = load_task(root, read(active_path)["task_id"])
        require(old["status"] == "COMPLETE", "ACTIVE_TASK_EXISTS")
    packet = retrieval(root, feature)  # Fail before any baseline/plan when vault unavailable.
    baseline = snapshot(root)
    status = git(root, "status", "--porcelain=v1", "-z").decode()
    # Record pre-existing modifications as immutable for this task. A new task may
    # not silently adopt them. Explicitly resolve their ownership before beginning.
    dirty = set(git(root, "diff", "--name-only", "-z").decode().split("\0")) - {""}
    dirty |= set(git(root, "diff", "--cached", "--name-only", "-z").decode().split("\0")) - {""}
    dirty |= set(git(root, "ls-files", "--others", "--exclude-standard", "-z").decode().split("\0")) - {""}
    dirty = {x for x in dirty if not x.startswith(".argo/runtime/")}
    save(p / "retrieval.json", packet)
    save(p / "baseline.json", {"files": baseline, "index": index_snapshot(root), "head": git(root, "rev-parse", "HEAD").decode().strip(),
                              "branch": git(root, "branch", "--show-current").decode().strip(),
                              "status": status, "dirty": sorted(dirty), "at": now()})
    save(p / "task.json", {"id": ident, "status": "INVESTIGATED", "feature": feature,
                           "policy": policy(root),
                           "baseline_hash": sha((p / "baseline.json").read_bytes()),
                           "retrieval_hash": sha((p / "retrieval.json").read_bytes()), "created_at": now()})
    save(active_path, {"task_id": ident})
    return packet


def plan(root, ident, contract_path):
    p, task = load_task(root, ident)
    require(task["status"] in ("INVESTIGATED", "REJECTED", "EXECUTING"), "INVALID_PLAN_STATE")
    c = read(contract_path)
    for key in ("REQUESTED_CHANGE", "ALLOWED_SCOPE", "PROTECTED_SCOPE", "EXPECTED_SIDE_EFFECTS",
                "acceptance", "executor", "reviewer", "checks", "protected_exceptions"):
        require(key in c, "CONTRACT_FIELD_MISSING:" + key)
    require(c["REQUESTED_CHANGE"] and c["acceptance"] and c["executor"] != c["reviewer"], "INVALID_CONTRACT")
    require(isinstance(c["ALLOWED_SCOPE"], dict) and c["ALLOWED_SCOPE"], "EXACT_ALLOWLIST_REQUIRED")
    for name, reason in c["ALLOWED_SCOPE"].items():
        safe(root, name)
        require(not any(x in name for x in "*?[") and isinstance(reason, str) and reason.strip(), "EXACT_FILE_REASON_REQUIRED")
        protected = any(fnmatch.fnmatchcase(name, pat) for pat in task["policy"]["protected"])
        if protected:
            require(c["protected_exceptions"].get(name, {}).get("user_authorization"), "PROTECTED_SCOPE:" + name)
    required = set(task["policy"]["required_checks"])
    require(required <= set(c["checks"]), "REGRESSION_CHECKS_MISSING")
    for name, check in c["checks"].items():
        require(isinstance(check.get("argv"), list) and check["argv"] and
                all(isinstance(s, str) for s in check["argv"]), "CHECK_ARGV_REQUIRED:" + name)
    # Re-planning is versioned and invalidates all previous receipts.
    rev = task.get("plan_revision", 0) + 1
    save(p / f"contract-{rev}.json", c)
    task.update(status="PLANNED", plan_revision=rev, contract_hash=digest(c))
    task.pop("review", None)
    task.pop("regression", None)
    set_task(p, task)
    return {"status": "PLANNED", "revision": rev}


def contract(p, task):
    c = read(p / f"contract-{task['plan_revision']}.json")
    require(digest(c) == task["contract_hash"], "CONTRACT_TAMPERED")
    return c


def execute(root, ident):
    p, t = load_task(root, ident)
    require(t["status"] == "PLANNED", "PLAN_REQUIRED")
    c = contract(p, t)
    require(sha((p / "retrieval.json").read_bytes()) == t["retrieval_hash"], "RETRIEVAL_TAMPERED")
    require(sha((p / "baseline.json").read_bytes()) == t["baseline_hash"], "BASELINE_TAMPERED")
    # Reuse original ARGO owner/claim ledger inside this task's runtime directory.
    a = SimpleNamespace(root=str(p), task_id=ident, project_id=policy(root)["project_id"], role="Executor",
                        owner=c["executor"], objective=c["REQUESTED_CHANGE"], read=[],
                        write=list(c["ALLOWED_SCOPE"]), depends=[], accept=c["acceptance"])
    ledger_base = p / ".argo"
    if not (ledger_base / "tasks" / (ident + ".json")).exists():
        ledger.create(a)
        ledger.claim(SimpleNamespace(root=str(p), task_id=ident, worker=c["executor"], context=str(p / "retrieval.json")))
    else:
        old = read(ledger_base / "tasks" / (ident + ".json"))
        old.update(status="IN_PROGRESS", write_set=list(c["ALLOWED_SCOPE"]))
        save(ledger_base / "tasks" / (ident + ".json"), old)
    t["status"] = "EXECUTING"
    set_task(p, t)


def diff_gate(root, ident):
    p, t = load_task(root, ident)
    c = contract(p, t)
    require(sha((p / "baseline.json").read_bytes()) == t["baseline_hash"], "BASELINE_TAMPERED")
    require(sha((p / "retrieval.json").read_bytes()) == t["retrieval_hash"], "RETRIEVAL_TAMPERED")
    b = read(p / "baseline.json")
    require(git(root, "rev-parse", "HEAD").decode().strip() == b["head"], "HEAD_CHANGED_REINVESTIGATE")
    current = snapshot(root)
    current_index = index_snapshot(root)
    index_changed = {x for x in set(b["index"]) | set(current_index) if b["index"].get(x) != current_index.get(x)}
    changed = sorted({x for x in set(b["files"]) | set(current) if b["files"].get(x) != current.get(x)} | index_changed)
    errors = []
    for name in changed:
        if name not in c["ALLOWED_SCOPE"]:
            errors.append("OUT_OF_SCOPE_MODIFICATION:" + name)
        if name in b["dirty"]:
            errors.append("PREEXISTING_USER_WORK_CHANGED:" + name)
        if any(fnmatch.fnmatchcase(name, pat) for pat in t["policy"]["protected"]) and not c["protected_exceptions"].get(name, {}).get("user_authorization"):
            errors.append("PROTECTED_SCOPE:" + name)
        if name in index_changed and name in current_index:
            # git hash-object applies the repo's normal clean/EOL filters, avoiding
            # CRLF false positives while proving the commit bytes were tested.
            f = safe(root, name)
            if not f.is_file() or git(root, 'hash-object', '--path=' + name, '--', name).decode().strip() != current_index[name]['blob']:
                errors.append('INDEX_WORKTREE_MISMATCH:' + name)
        elif name in index_changed and safe(root, name).is_file():
            errors.append('INDEX_WORKTREE_MISMATCH:' + name)
    result = {"status": "REJECT" if errors else "PASS", "errors": errors, "tree": tree(root),
              "modified_file_to_requested_change": {x: c["ALLOWED_SCOPE"].get(x) for x in changed}, "at": now()}
    save(p / "diff.json", result)
    if errors:
        t["status"] = "REJECTED"
        set_task(p, t)
    return result


def regress(root, ident):
    p, t = load_task(root, ident)
    require(t["status"] == "EXECUTING", "EXECUTOR_NOT_ACTIVE")
    require(diff_gate(root, ident)["status"] == "PASS", "DIFF_REJECTED")
    c = contract(p, t)
    before = tree(root)
    results = {}
    for name, check in c["checks"].items():
        try:
            proc = subprocess.run(check["argv"], cwd=root, capture_output=True, timeout=check.get("timeout", 600))
            # Local logs are evidence, never included wholesale in memory.
            log = proc.stdout + b"\n" + proc.stderr
            safe(p, "check-" + name + ".log").write_bytes(log)
            results[name] = {"exit_code": proc.returncode, "log_sha256": sha(log), "argv": check["argv"]}
        except (OSError, subprocess.TimeoutExpired) as e:
            results[name] = {"exit_code": -1, "error": type(e).__name__, "argv": check["argv"]}
    require(tree(root) == before, "TESTS_CHANGED_SOURCE")
    receipt = {"tree": before, "contract_hash": t["contract_hash"], "at": now(), "checks": results,
               "status": "PASS" if all(x["exit_code"] == 0 for x in results.values()) else "FAIL"}
    save(p / "regression.json", receipt)
    t["regression"] = digest(receipt)
    if receipt["status"] != "PASS":
        t["status"] = "REJECTED"
    set_task(p, t)
    return receipt


def review(root, ident, actor, verdict, notes):
    p, t = load_task(root, ident)
    c = contract(p, t)
    require(actor == c["reviewer"] and actor != c["executor"], "INDEPENDENT_REVIEWER_REQUIRED")
    require(notes.strip(), "REVIEW_EVIDENCE_REQUIRED")
    if verdict == "PASS":
        require(diff_gate(root, ident)["status"] == "PASS", "DIFF_REJECTED")
        r = read(p / "regression.json")
        require(t.get("regression") == digest(r) and r["status"] == "PASS" and r["tree"] == tree(root)
                and r["contract_hash"] == t["contract_hash"], "STALE_OR_FAILED_REGRESSION")
        require(t["status"] == "EXECUTING", "EXECUTOR_NOT_ACTIVE")
    verdict_record = {"actor": actor, "verdict": verdict, "notes": notes, "tree": tree(root), "at": now()}
    save(p / ("review-" + str(t["plan_revision"]) + ".json"), verdict_record)
    if verdict == "PASS":
        ledger.ready(SimpleNamespace(root=str(p), task_id=ident, worker=c["executor"], evidence=[str(p / "regression.json"), str(p / "diff.json")], notes=[]))
        ledger.accept(SimpleNamespace(root=str(p), task_id=ident, verifier=actor, verdict="pass", evidence=[notes], notes=[]))
    t.update(status="REVIEWED" if verdict == "PASS" else "REJECTED", review=verdict_record)
    set_task(p, t)
    return verdict_record


def append(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        require(read(path) == obj, "APPEND_ONLY_CONFLICT:" + str(path))
        return
    with path.open("x", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())


def compress(root, force=False):
    _, paths = memory_paths(root)
    records = []
    sources = {}
    for kind in ("raw", "decisions", "regressions"):
        for p in sorted(paths[kind].glob("*.json")) if paths[kind].exists() else []:
            sources[str(p)] = sha(p.read_bytes())
            records.append({"kind": kind, "source": str(p), "record": read(p)})
    sources[str(paths["working"])] = sha(paths["working"].read_bytes())
    target = paths["summary"] / "current.json"
    old = read(target) if target.exists() else {}
    delta = sum(old.get("sources", {}).get(k) != v for k, v in sources.items())
    threshold = policy(root)["compression_threshold_entries"]
    if old and delta < threshold and not force:
        return {"updated": False, "new_or_changed_sources": delta, "threshold": threshold}
    # Deterministic extractive summary: source references retained, no fabricated model facts.
    result = {"derived": True, "at": now(), "sources": sources,
              "items": [{"kind": r["kind"], "source": r["source"],
                         "summary": str(r["record"].get("final_outcome", r["record"].get("Decision", r["record"].get("event", ""))))[:600]}
                        for r in records[-30:]], "working_memory": str(paths["working"])}
    save(target, result)
    require(all(Path(k).is_file() and sha(Path(k).read_bytes()) == v for k, v in sources.items()), "COMPRESSION_CHANGED_HISTORY")
    return {"updated": True, "path": str(target), "source_count": len(sources)}


def complete(root, ident, input_path):
    p, t = load_task(root, ident)
    require(t["status"] in ("REVIEWED", "MEMORY_PENDING"), "REVIEWER_PASS_REQUIRED")
    require(t["review"]["verdict"] == "PASS" and t["review"]["tree"] == tree(root), "STALE_REVIEW")
    require(diff_gate(root, ident)["status"] == "PASS", "DIFF_REJECTED")
    payload = read(input_path)
    fields = ("task", "user_request", "relevant_context", "decisions", "rejected_approaches", "discovered_constraints",
              "bugs", "regressions", "tests_performed", "user_correction", "final_outcome", "state")
    require(all(k in payload for k in fields), "MEMORY_FIELDS_MISSING")
    v, paths = memory_paths(root)
    sm = module(v / "工具/state_memory.py", "argo_state_memory_commit")
    state = payload["state"]
    require(state["id"] == policy(root)["project_id"], "PROJECT_STATE_MISMATCH")
    if "memory_stamp" not in t:
        t["memory_stamp"] = now()
    t["status"] = "MEMORY_PENDING"
    set_task(p, t)
    raw = {k: payload[k] for k in fields if k != "state"}
    raw.update(timestamp=t["memory_stamp"], affected_project=policy(root)["project_id"],
               files_changed=read(p / "diff.json")["modified_file_to_requested_change"],
               reviewer_result=t["review"], regression_receipt=read(p / "regression.json"), task_id=ident)
    append(paths["raw"] / (ident + ".json"), raw)
    for kind in ("decisions", "regressions"):
        for index, item in enumerate(payload[kind]):
            if kind == "decisions":
                require(all(k in item for k in ("Decision", "Context", "Reason", "Alternatives", "Consequences", "Date", "Related files/features")), "DECISION_FIELDS_MISSING")
            else:
                require(all(k in item for k in ("event", "Cause", "Prevention", "Required regression checks")), "REGRESSION_FIELDS_MISSING")
            append(paths[kind] / f"{ident}-{index + 1}.json", item)
    current = sm.read(paths["working"])
    expected = payload["expected_revision"]
    # state_memory.put handles idempotent retry after a partial memory transaction.
    updated = sm.put(v, state, expected)
    sm.check(updated, v)
    summary_result = compress(root)
    readback = json.loads(sm.context(v, policy(root)["project_id"]))
    require(readback["state"]["revision"] == updated["revision"], "MEMORY_READBACK_FAILED")
    t.update(status="COMPLETE", memory={"raw": str(paths["raw"] / (ident + ".json")),
             "raw_hash": sha((paths["raw"] / (ident + ".json")).read_bytes()), "state_revision": updated["revision"],
             "summary": summary_result}, completed_tree=tree(root))
    set_task(p, t)
    return {"status": "COMPLETE", "memory": t["memory"]}


def completion_gate(root):
    active = root / ".argo/runtime/active.json"
    require(active.exists(), "NO_TASK_CONTRACT")
    ident = read(active)["task_id"]
    p, t = load_task(root, ident)
    require(t["status"] == "COMPLETE", "TASK_NOT_COMPLETE:" + t["status"])
    require(t["completed_tree"] == tree(root), "CHANGES_AFTER_REVIEW")
    require(diff_gate(root, ident)['status'] == 'PASS', 'DIFF_REJECTED')
    require(sha(Path(t["memory"]["raw"]).read_bytes()) == t["memory"]["raw_hash"], "RAW_MEMORY_CHANGED")
    return {"status": "PASS", "task_id": ident}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default=".")
    sp = ap.add_subparsers(dest="cmd", required=True)
    q = sp.add_parser("retrieve"); q.add_argument("feature")
    q = sp.add_parser("begin"); q.add_argument("id"); q.add_argument("--feature", required=True)
    q = sp.add_parser("plan"); q.add_argument("id"); q.add_argument("contract")
    for command in ("execute", "diff", "regress", "status"):
        q = sp.add_parser(command); q.add_argument("id")
    q = sp.add_parser("review"); q.add_argument("id"); q.add_argument("--actor", required=True); q.add_argument("--verdict", choices=("PASS", "REJECT"), required=True); q.add_argument("--notes", required=True)
    q = sp.add_parser("complete"); q.add_argument("id"); q.add_argument("input")
    sp.add_parser("gate")
    sp.add_parser("compress")
    a = ap.parse_args(); root = Path(a.root).resolve()
    try:
        if a.cmd == "retrieve": result = retrieval(root, a.feature)
        elif a.cmd == "begin": result = begin(root, a.id, a.feature)
        elif a.cmd == "plan": result = plan(root, a.id, Path(a.contract))
        elif a.cmd == "execute": result = execute(root, a.id)
        elif a.cmd == "diff": result = diff_gate(root, a.id)
        elif a.cmd == "regress": result = regress(root, a.id)
        elif a.cmd == "review": result = review(root, a.id, a.actor, a.verdict, a.notes)
        elif a.cmd == "complete": result = complete(root, a.id, Path(a.input))
        elif a.cmd == "gate": result = completion_gate(root)
        elif a.cmd == "compress": result = compress(root)
        else: result = load_task(root, a.id)[1]
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if isinstance(result, dict) and result.get("status") in ("REJECT", "FAIL"):
            return 2
        return 0
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as e:
        print("REJECT: " + str(e), file=sys.stderr)
        return 2


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    sys.exit(main())
