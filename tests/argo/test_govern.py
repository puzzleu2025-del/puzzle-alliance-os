"""ARGO integration contracts using disposable Git repositories and memory vaults.

Run: python -m unittest discover -s tests/argo -p test_govern.py -v
ARGO_STATE_MEMORY_SOURCE may point to the installed state_memory.py on another host.
No real project or vault is mutated.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts' / 'argo'))
import govern as g

STATE_SOURCE = Path(os.environ.get('ARGO_STATE_MEMORY_SOURCE', 'E:/個人營運記憶庫/工具/state_memory.py'))


class GovernanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='argo-govern-test-')
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.root = self.home / 'repo'
        self.root.mkdir()
        self.vault = self.home / 'vault'
        (self.vault / '工具').mkdir(parents=True)
        if not STATE_SOURCE.is_file():
            self.fail('Set ARGO_STATE_MEMORY_SOURCE to the existing state_memory.py')
        shutil.copy2(STATE_SOURCE, self.vault / '工具/state_memory.py')
        self.sm = g.module(self.vault / '工具/state_memory.py', 'test_state_memory')
        self.state = dict(id='sample', entity='project', name='Sample', owner='Owner',
                          status='active', evidence=['fixture baseline'], aliases=[],
                          next_actions=[], blockers=[], acceptance_evidence=[], detail_refs=[])
        self.sm.put(self.vault, self.state, 0)
        self.env = patch.dict(os.environ, {'ARGO_VAULT': str(self.vault)})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.policy = dict(project_id='sample', vault=str(self.vault), protected=['auth/**'],
                           required_checks=['smoke'], compression_threshold_entries=3,
                           memory=dict(working='12-狀態/sample.md', raw='raw', specs='specs',
                                       decisions='decisions', regressions='regressions', summary='summary'))
        self.write('.argo/policy.json', json.dumps(self.policy))
        self.write('.gitignore', '.argo/runtime/\n')
        self.write('allowed.txt', 'base\n')
        self.write('outside.txt', 'outside\n')
        self.write('auth/login.txt', 'login\n')
        self.git('init', '-q')
        self.git('config', 'user.name', 'Governance Fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('config', 'core.autocrlf', 'false')
        self.git('add', '.')
        self.git('commit', '-qm', 'fixture baseline')
        self.contract = dict(REQUESTED_CHANGE='Update allowed text',
                             ALLOWED_SCOPE={'allowed.txt': 'Requested text correction'},
                             PROTECTED_SCOPE=['auth/**'], EXPECTED_SIDE_EFFECTS=[],
                             acceptance=['correct text'], executor='executor', reviewer='reviewer',
                             checks={'smoke': {'argv': [sys.executable, '-c',
                                 "from pathlib import Path; assert Path('auth/login.txt').read_text() == 'login\\n'"]}},
                             protected_exceptions={})
        self.ident = 'task-1'

    def write(self, name, text):
        p = self.root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding='utf-8')
        return p

    def git(self, *args):
        return subprocess.check_output(['git', '-c', 'safe.directory=' + self.root.as_posix(),
                                       '-C', str(self.root), *args], stderr=subprocess.STDOUT)

    def begin(self):
        return g.begin(self.root, self.ident, 'text correction')

    def plan(self):
        p = self.home / 'contract.json'
        p.write_text(json.dumps(self.contract), encoding='utf-8')
        return g.plan(self.root, self.ident, p)

    def start(self):
        self.begin()
        self.plan()
        g.execute(self.root, self.ident)

    def status(self):
        return g.load_task(self.root, self.ident)[1]['status']

    def reviewed(self):
        self.start()
        self.write('allowed.txt', 'corrected\n')
        self.assertEqual(g.regress(self.root, self.ident)['status'], 'PASS')
        g.review(self.root, self.ident, 'reviewer', 'PASS', 'Inspected requested text and regression evidence')

    def payload(self):
        state = copy.deepcopy(self.state)
        state.update(status='completed', acceptance_evidence=['reviewer PASS and smoke PASS'])
        d = dict(task=self.ident, user_request='Update allowed text', relevant_context=['baseline'],
                 decisions=[], rejected_approaches=[], discovered_constraints=[], bugs=[],
                 regressions=[], tests_performed=['smoke'], user_correction=[],
                 final_outcome='Text corrected and reviewed', state=state, expected_revision=1)
        p = self.home / 'memory.json'
        p.write_text(json.dumps(d), encoding='utf-8')
        return p

    def test_unstaged_out_of_scope_rejected(self):
        self.start()
        self.write('outside.txt', 'unauthorized')
        result = g.diff_gate(self.root, self.ident)
        self.assertIn('OUT_OF_SCOPE_MODIFICATION:outside.txt', result['errors'])
        self.assertEqual(self.status(), 'REJECTED')

    def test_staged_out_of_scope_rejected(self):
        self.start()
        self.write('outside.txt', 'unauthorized')
        self.git('add', 'outside.txt')
        self.assertEqual(g.diff_gate(self.root, self.ident)['status'], 'REJECT')

    def test_index_only_out_of_scope_rejected(self):
        self.start()
        self.write('outside.txt', 'unauthorized staged content')
        self.git('add', 'outside.txt')
        self.write('outside.txt', 'outside\n')
        self.assertEqual(g.diff_gate(self.root, self.ident)['status'], 'REJECT')

    def test_untracked_out_of_scope_rejected(self):
        self.start()
        self.write('new.txt', 'unauthorized')
        self.assertEqual(g.diff_gate(self.root, self.ident)['status'], 'REJECT')

    def test_new_tool_absent_from_baseline_is_mapped(self):
        self.contract['ALLOWED_SCOPE']['scripts/new-tool.py'] = 'Requested governance bootstrap'
        self.start()
        self.write('scripts/new-tool.py', 'print("new tool")\n')
        result = g.diff_gate(self.root, self.ident)
        self.assertEqual(result['status'], 'PASS')
        self.assertIn('scripts/new-tool.py', result['modified_file_to_requested_change'])

    def test_preexisting_untracked_tool_cannot_be_silently_adopted(self):
        self.write('scripts/new-tool.py', 'existing user tool\n')
        self.contract['ALLOWED_SCOPE']['scripts/new-tool.py'] = 'Requested governance bootstrap'
        self.start()
        self.write('scripts/new-tool.py', 'changed agent tool\n')
        self.assertIn('PREEXISTING_USER_WORK_CHANGED:scripts/new-tool.py',
                      g.diff_gate(self.root, self.ident)['errors'])

    def test_deleted_out_of_scope_rejected(self):
        self.start()
        (self.root / 'outside.txt').unlink()
        self.assertEqual(g.diff_gate(self.root, self.ident)['status'], 'REJECT')

    def test_allowed_delete_is_mapped(self):
        self.start()
        (self.root / 'allowed.txt').unlink()
        result = g.diff_gate(self.root, self.ident)
        self.assertEqual(result['status'], 'PASS')
        self.assertIn('allowed.txt', result['modified_file_to_requested_change'])

    def test_preexisting_dirty_file_cannot_be_adopted(self):
        self.write('allowed.txt', 'user work')
        self.start()
        self.write('allowed.txt', 'agent overwrote user work')
        self.assertIn('PREEXISTING_USER_WORK_CHANGED:allowed.txt',
                      g.diff_gate(self.root, self.ident)['errors'])

    def test_preexisting_staged_change_is_protected(self):
        self.write('allowed.txt', 'user staged work')
        self.git('add', 'allowed.txt')
        self.start()
        self.write('allowed.txt', 'agent work')
        self.assertEqual(g.diff_gate(self.root, self.ident)['status'], 'REJECT')

    def test_protected_allowlist_needs_authorization(self):
        self.begin()
        self.contract['ALLOWED_SCOPE'] = {'auth/login.txt': 'requested fix'}
        with self.assertRaisesRegex(ValueError, 'PROTECTED_SCOPE'):
            self.plan()

    def test_explicit_protected_exception(self):
        self.contract['ALLOWED_SCOPE'] = {'auth/login.txt': 'authorized login fix'}
        self.contract['protected_exceptions'] = {'auth/login.txt': {'user_authorization': 'Explicit fixture request'}}
        self.start()
        self.write('auth/login.txt', 'authorized change')
        self.assertEqual(g.diff_gate(self.root, self.ident)['status'], 'PASS')

    def test_stale_regression_cannot_be_reviewed(self):
        self.start()
        g.regress(self.root, self.ident)
        self.write('allowed.txt', 'changed after check')
        with self.assertRaisesRegex(ValueError, 'STALE_OR_FAILED_REGRESSION'):
            g.review(self.root, self.ident, 'reviewer', 'PASS', 'inspection')

    def test_stale_review_cannot_complete(self):
        self.reviewed()
        self.write('allowed.txt', 'changed after review')
        with self.assertRaisesRegex(ValueError, 'STALE_REVIEW'):
            g.complete(self.root, self.ident, self.payload())

    def test_reject_returns_to_executor_with_new_plan(self):
        self.start()
        g.review(self.root, self.ident, 'reviewer', 'REJECT', 'text is not corrected')
        self.assertEqual(self.status(), 'REJECTED')
        with self.assertRaisesRegex(ValueError, 'PLAN_REQUIRED'):
            g.execute(self.root, self.ident)
        self.plan()
        g.execute(self.root, self.ident)
        self.assertEqual(self.status(), 'EXECUTING')
        self.write('allowed.txt', 'corrected\n')
        self.assertEqual(g.regress(self.root, self.ident)['status'], 'PASS')
        g.review(self.root, self.ident, 'reviewer', 'PASS', 'corrected after rejection')
        self.assertEqual(self.status(), 'REVIEWED')

    def test_self_review_refused(self):
        self.start()
        with self.assertRaisesRegex(ValueError, 'INDEPENDENT_REVIEWER_REQUIRED'):
            g.review(self.root, self.ident, 'executor', 'PASS', 'self inspection')

    def test_failed_check_rejects(self):
        self.contract['checks']['smoke']['argv'] = [sys.executable, '-c', 'raise SystemExit(3)']
        self.start()
        self.assertEqual(g.regress(self.root, self.ident)['status'], 'FAIL')
        self.assertEqual(self.status(), 'REJECTED')

    def test_raw_append_is_idempotent_but_cannot_overwrite(self):
        p = self.vault / 'raw/event.json'
        g.append(p, {'event': 'original'})
        before = p.read_bytes()
        g.append(p, {'event': 'original'})
        with self.assertRaisesRegex(ValueError, 'APPEND_ONLY_CONFLICT'):
            g.append(p, {'event': 'replacement'})
        self.assertEqual(p.read_bytes(), before)

    def test_summary_threshold_preserves_source_bytes_and_references(self):
        raw = self.vault / 'raw'
        g.append(raw / 'one.json', {'final_outcome': 'one'})
        self.assertTrue(g.compress(self.root)['updated'])
        summary = self.vault / 'summary/current.json'
        before_summary = summary.read_bytes()
        g.append(raw / 'two.json', {'final_outcome': 'two'})
        self.assertFalse(g.compress(self.root)['updated'])
        self.assertEqual(summary.read_bytes(), before_summary)
        g.append(raw / 'three.json', {'final_outcome': 'three'})
        g.append(raw / 'four.json', {'final_outcome': 'four'})
        originals = {p: p.read_bytes() for p in raw.glob('*.json')}
        self.assertTrue(g.compress(self.root)['updated'])
        result = g.read(summary)
        for p, data in originals.items():
            self.assertEqual(p.read_bytes(), data)
            self.assertEqual(result['sources'][str(p)], g.sha(data))
            self.assertIn(str(p), [item['source'] for item in result['items']])

    def test_missing_retrieval_blocks_execution(self):
        self.begin()
        self.plan()
        (g.base(self.root, self.ident) / 'retrieval.json').unlink()
        with self.assertRaises((ValueError, OSError)):
            g.execute(self.root, self.ident)

    def test_missing_contract_blocks_execution(self):
        self.begin()
        with self.assertRaisesRegex(ValueError, 'PLAN_REQUIRED'):
            g.execute(self.root, self.ident)

    def test_missing_vault_fails_before_task_creation(self):
        with patch.dict(os.environ, {'ARGO_VAULT': str(self.home / 'absent')}):
            with self.assertRaisesRegex(ValueError, 'MEMORY_VAULT_UNAVAILABLE'):
                self.begin()
        self.assertFalse(g.base(self.root, self.ident).exists())

    def test_no_task_gate_refused(self):
        with self.assertRaisesRegex(ValueError, 'NO_TASK_CONTRACT'):
            g.completion_gate(self.root)

    def test_complete_and_gate_with_memory_readback(self):
        self.reviewed()
        self.assertEqual(g.complete(self.root, self.ident, self.payload())['status'], 'COMPLETE')
        self.assertEqual(g.completion_gate(self.root)['status'], 'PASS')
        state = json.loads(self.sm.context(self.vault, 'sample'))['state']
        self.assertEqual(state['revision'], 2)
        self.assertEqual(state['status'], 'completed')
        raw = g.read(self.vault / 'raw/task-1.json')
        self.assertEqual(raw['reviewer_result']['actor'], 'reviewer')
        self.assertIn('allowed.txt', raw['files_changed'])
        self.write('allowed.txt', 'post completion edit')
        with self.assertRaisesRegex(ValueError, 'CHANGES_AFTER_REVIEW'):
            g.completion_gate(self.root)

    def test_raw_tamper_invalidates_completion_gate(self):
        self.reviewed()
        g.complete(self.root, self.ident, self.payload())
        (self.vault / 'raw/task-1.json').write_text('{}', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'RAW_MEMORY_CHANGED'):
            g.completion_gate(self.root)

    def test_staging_reviewed_bytes_after_completion_is_safe(self):
        self.reviewed()
        g.complete(self.root, self.ident, self.payload())
        self.git('add', 'allowed.txt')
        self.assertEqual(g.completion_gate(self.root)['status'], 'PASS')

    def test_changed_staged_bytes_after_completion_are_rejected(self):
        self.reviewed()
        g.complete(self.root, self.ident, self.payload())
        self.write('allowed.txt', 'unreviewed content')
        self.git('add', 'allowed.txt')
        self.write('allowed.txt', 'corrected\n')
        with self.assertRaises(ValueError):
            g.completion_gate(self.root)

    def test_index_deletion_with_reviewed_worktree_retained_is_rejected(self):
        self.reviewed()
        g.complete(self.root, self.ident, self.payload())
        self.git('rm', '--cached', 'allowed.txt')
        self.assertTrue((self.root / 'allowed.txt').exists())
        with self.assertRaises(ValueError):
            g.completion_gate(self.root)

    def test_unreviewed_index_mode_change_is_rejected(self):
        self.reviewed()
        g.complete(self.root, self.ident, self.payload())
        self.git('add', 'allowed.txt')
        self.git('update-index', '--chmod=+x', 'allowed.txt')
        with self.assertRaises(ValueError):
            g.completion_gate(self.root)


if __name__ == '__main__':
    unittest.main()
