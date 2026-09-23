// Portable launcher; ARGO_PYTHON may select an existing interpreter. No installs.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const candidates = [process.env.ARGO_PYTHON,
  process.env.USERPROFILE && join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'),
  'python3', 'python'].filter(Boolean);
const python = candidates.find(p => (p.includes('/') || p.includes('\\')) ? existsSync(p) : spawnSync(p, ['--version'], {windowsHide:true}).status === 0);
if (!python) throw new Error('Python 3 is required. Set ARGO_PYTHON to an existing interpreter.');
const args = process.argv.slice(2);
const script = args[0] === 'hook' ? (args.shift(), 'hook.py') : 'govern.py';
const result = spawnSync(python, [join(here, script), ...args], {stdio:'inherit', windowsHide:true});
process.exit(result.status ?? 2);
