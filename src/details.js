'use strict';
// Commit details and comparisons: message, people, parents and the changed files with +/- counts.
const { runGit } = require('./git/runner');
const P = require('./git/parse');

const MAX_BYTES = 32 * 1024 * 1024;

function mergeCounts(files, num) {
  for (const f of files) { const n = num.get(f.path); if (n) { f.add = n.add; f.del = n.del; } }
  return files;
}

async function filesBetween(git, cwd, a, b, { maxFiles = 5000, root = false } = {}) {
  // b === null: working tree. root: a is a root commit (compare with the empty tree).
  const base = root ? ['diff-tree', '-r', '-z', '-M', '--root', '--no-commit-id', '--no-ext-diff', '--no-textconv', b] : b ? ['diff', '-z', '-M', '--no-ext-diff', '--no-textconv', a, b, '--'] : ['diff', '-z', '-M', '--no-ext-diff', '--no-textconv', a, '--'];
  const [ns, num] = await Promise.all([
    runGit(git, [...base.slice(0, 1), '--name-status', ...base.slice(1)], { cwd, timeoutMs: 120000, maxBytes: MAX_BYTES }),
    runGit(git, [...base.slice(0, 1), '--numstat', ...base.slice(1)], { cwd, timeoutMs: 120000, maxBytes: MAX_BYTES }).catch(() => ({ stdout: '' })),
  ]);
  const files = mergeCounts(P.parseNameStatus(ns.stdout), P.parseNumstat(num.stdout));
  return { files: files.slice(0, maxFiles), total: files.length };
}

async function commitDetails(git, cwd, hash, opts = {}) {
  const r = await runGit(git, ['show', '--no-textconv', '--no-ext-diff', '-s', '-z', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B', hash, '--'], { cwd, timeoutMs: 30000 });
  const p = r.stdout.replace(/\0+$/, '').split('\x1f');
  if (p.length < 9 || !P.HASH.test(p[0])) throw new Error('Could not read commit ' + hash.slice(0, 12));
  const parents = p[1].split(' ').filter(Boolean);
  const c = { hash: p[0], parents, author: p[2], email: p[3], date: Number(p[4]), committer: p[5], committerEmail: p[6], cdate: Number(p[7]), message: p.slice(8).join('\x1f').replace(/\s+$/, '') };
  const parent = opts.parent && parents.includes(opts.parent) ? opts.parent : parents[0];
  const f = parents.length ? await filesBetween(git, cwd, parent, hash, opts) : await filesBetween(git, cwd, null, hash, { ...opts, root: true });
  return { ...c, files: f.files, totalFiles: f.total, comparedTo: parent || null };
}

async function stashDetails(git, cwd, hash, opts) {
  const d = await commitDetails(git, cwd, hash, opts);
  // untracked files of a stash live in its third parent
  if (d.parents[2]) {
    try {
      const u = await filesBetween(git, cwd, null, d.parents[2], { ...opts, root: true });
      for (const f of u.files) d.files.push({ ...f, status: 'A', untracked: true, at: d.parents[2] });
      d.totalFiles += u.total;
    } catch (_) { /* no untracked part */ }
  }
  return d;
}

async function workingTreeDetails(git, cwd, opts = {}) {
  const [diff, st] = await Promise.all([
    filesBetween(git, cwd, 'HEAD', null, opts),
    runGit(git, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=dirty'], { cwd, timeoutMs: 30000 }),
  ]);
  const entries = P.parseStatus(st.stdout);
  const staged = new Set(entries.filter(e => e.x !== ' ' && e.x !== '?').map(e => e.path));
  for (const f of diff.files) f.staged = staged.has(f.path);
  const untracked = entries.filter(e => e.x === '?').map(e => ({ status: 'U', path: e.path, oldPath: e.path, untracked: true }));
  const conflicts = entries.filter(e => e.x === 'U' || e.y === 'U' || (e.x === 'A' && e.y === 'A') || (e.x === 'D' && e.y === 'D')).map(e => e.path);
  return { files: [...diff.files, ...untracked].slice(0, opts.maxFiles || 5000), totalFiles: diff.total + untracked.length, conflicts };
}

module.exports = { commitDetails, stashDetails, workingTreeDetails, filesBetween };
