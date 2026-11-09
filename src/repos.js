'use strict';
// Finds the git repositories of the workspace: each folder's own repository, repositories nested a few levels
// down, and initialised submodules. Reads only the file system and `git rev-parse` (hooks off).
const fs = require('fs');
const path = require('path');
const { runGit } = require('./git/runner');

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', '.venv', 'venv', '__pycache__', '.gradle', '.next', 'vendor', 'Pods']);

function realpath(p) { try { return fs.realpathSync.native(p); } catch (_) { return p; } }

/** Folders under root (depth levels) that contain a .git folder or file. */
function nestedCandidates(root, depth) {
  const out = [];
  const walk = (dir, d) => {
    if (d > depth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (fs.existsSync(path.join(p, '.git'))) out.push(p);
      if (out.length > 200) return;
      walk(p, d + 1);
    }
  };
  walk(root, 1);
  return out;
}

/** Repository facts for a folder, or null when it is not in a repository. */
async function inspect(git, folder) {
  try {
    const r = await runGit(git, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--is-bare-repository', '--is-shallow-repository'], { cwd: folder, timeoutMs: 20000 });
    const [top, gitDir, bare, shallow] = r.stdout.split('\n').map(s => s.trim());
    if (bare === 'true') return { root: folder, gitDir: gitDir || folder, bare: true, shallow: shallow === 'true' };
    if (!top) return null;
    return { root: top, gitDir, bare: false, shallow: shallow === 'true' };
  } catch (e) {
    // a bare repository opened as the folder answers --is-bare-repository but has no toplevel
    try {
      const r = await runGit(git, ['rev-parse', '--absolute-git-dir', '--is-bare-repository'], { cwd: folder, timeoutMs: 20000 });
      const [gitDir, bare] = r.stdout.split('\n').map(s => s.trim());
      if (bare === 'true') return { root: folder, gitDir, bare: true, shallow: false };
    } catch (_) { /* not a repository */ }
    if (/dubious ownership|safe\.directory/.test(e.stderr || '')) return { error: 'unsafe', folder, message: (e.stderr || e.message).trim().split('\n')[0] };
    return null;
  }
}

/** Initialised submodules of a repository (paths from .gitmodules that have their own .git). */
function submodules(root) {
  let text;
  try { text = fs.readFileSync(path.join(root, '.gitmodules'), 'utf8'); } catch (_) { return []; }
  const out = [];
  const re = /^\s*path\s*=\s*(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(text))) {
    const rel = m[1].replace(/^"|"$/g, '');
    if (rel.includes('..')) continue;
    const p = path.join(root, rel);
    if (fs.existsSync(path.join(p, '.git'))) out.push(p);
  }
  return out;
}

/** All repositories for these workspace folders: [{root, gitDir, bare, shallow, label, parent}]. */
async function discover(git, folders, { depth = 2, log = () => {} } = {}) {
  const seen = new Map();
  const problems = [];
  const add = async (folder, parentRoot) => {
    const info = await inspect(git, folder);
    if (!info) return null;
    if (info.error) { problems.push(info); return null; }
    const key = realpath(info.root);
    if (seen.has(key)) return seen.get(key);
    const repo = { ...info, key, parent: parentRoot || '' };
    seen.set(key, repo);
    log(`repository ${info.root}${info.bare ? ' (bare)' : ''}${info.shallow ? ' (shallow)' : ''}`);
    return repo;
  };
  for (const f of folders) {
    const top = await add(f);
    const roots = new Set();
    if (top) roots.add(top.root);
    for (const n of nestedCandidates(f, depth)) { const r = await add(n, top ? top.root : ''); if (r) roots.add(r.root); }
    for (const r of [...roots]) for (const s of submodules(r)) { const sr = await add(s, r); if (sr) for (const s2 of submodules(sr.root)) await add(s2, sr.root); }
  }
  const list = [...seen.values()];
  const base = folders.length === 1 ? realpath(folders[0]) : null;
  for (const r of list) {
    r.label = base && r.key !== base && r.key.startsWith(base + path.sep) ? path.relative(base, r.key) : path.basename(r.root);
    r.kind = r.parent ? (submodules(r.parent).some(p => realpath(p) === r.key) ? 'submodule' : 'nested') : 'folder';
  }
  list.sort((a, b) => (a.parent ? 1 : 0) - (b.parent ? 1 : 0) || a.label.localeCompare(b.label));
  return { repos: list, problems };
}

/** The repository that contains a file path (longest root wins). */
function repoFor(repos, file) {
  const f = realpath(file);
  let best = null;
  for (const r of repos) {
    const k = r.key;
    if ((f === k || f.startsWith(k + path.sep)) && (!best || k.length > best.key.length)) best = r;
  }
  return best;
}

module.exports = { discover, inspect, submodules, nestedCandidates, repoFor, realpath };
