'use strict';
// Real git: the worker, search over the full history, hostile repositories (hooks, fsmonitor, textconv must not
// run on read commands), squash and rebase compared with the git command line, history, compare and discovery.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const fx = require('./helpers/gitfix');
const { git, commit, repo } = fx;
const rebase = require('../src/rebase');
const details = require('../src/details');
const { fileHistory, lineHistory } = require('../src/views/history');
const { compareBranches, reportMarkdown } = require('../src/compareReport');
const repos = require('../src/repos');
const { runGit } = require('../src/git/runner');
const { createContentProvider, toUri } = require('../src/content');
const { explainLoadError } = require('../src/views/graphPanel');
const { operationFrom } = require('../src/git/parse');

test.after(() => fx.cleanup());

function openWorker(cwd, opts = {}) {
  const w = new Worker(path.join(__dirname, '..', 'src', 'graph', 'worker.js'), { workerData: { git: 'git', cwd } });
  let id = 0;
  const waiters = new Map();
  const state = { refs: null, done: null, error: null, progress: [] };
  let doneResolve;
  const done = new Promise(r => { doneResolve = r; });
  w.on('message', m => {
    if (m.type === 'refs') state.refs = m;
    else if (m.type === 'progress') state.progress.push(m);
    else if (m.type === 'done') { state.done = m; doneResolve(state); }
    else if (m.type === 'error') { state.error = m; doneResolve(state); }
    else if (m.partial) state.partials = (state.partials || 0) + 1;
    else if (waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  });
  const call = (msg) => new Promise(r => { const i = ++id; waiters.set(i, r); w.postMessage({ ...msg, id: i }); });
  w.postMessage({ type: 'load', opts });
  return { done, state, rows: (s, e) => call({ type: 'rows', start: s, end: e }).then(m => m.rows), search: q => call({ type: 'search', query: q }), close: () => w.terminate() };
}

function sampleRepo() {
  const d = repo('sample');
  const c1 = commit(d, 'a.txt', 'one\n', 'Initial commit');
  commit(d, 'src/app.js', 'let x = 1;\n', 'Add app');
  git(d, 'checkout', '-q', '-b', 'feature/ünïcode');
  commit(d, 'src/app.js', 'let x = 2;\nconst needle = "haystack";\n', 'Feature work\n\nThe body mentions zebra.');
  git(d, 'checkout', '-q', 'main');
  commit(d, 'b.txt', 'b\n', 'Main work');
  git(d, 'merge', '-q', '--no-ff', '-m', 'Merge feature', 'feature/ünïcode');
  git(d, 'tag', '-a', 'v1.0', '-m', 'Release 1.0');
  fs.appendFileSync(path.join(d, 'a.txt'), 'stashed\n');
  git(d, 'stash', '-q');
  fs.appendFileSync(path.join(d, 'b.txt'), 'dirty\n');
  return { d, c1 };
}

test('worker: branches, tags, stash, uncommitted row, merge lanes and refs', async () => {
  const { d } = sampleRepo();
  const w = openWorker(d);
  const st = await w.done;
  assert.equal(st.error, null);
  assert.equal(st.done.rows, 7); // wip + stash + 5 commits
  const rows = await w.rows(0, 10);
  assert.equal(rows[0].kind, 'wip');
  assert.equal(rows[1].kind, 'stash');
  assert.equal(rows[1].extra.selector, 'stash@{0}');
  const merge = rows.find(r => r.subject === 'Merge feature');
  assert.equal(merge.parents.length, 2);
  assert.deepEqual(merge.refs.map(r => r.name).sort(), ['main', 'v1.0']);
  assert.ok(rows.find(r => r.refs.some(x => x.name === 'feature/ünïcode')));
  assert.equal(merge.g.outs.length, 2);
  assert.equal(st.refs.refs.head, 'main');
  // filters: no tags, no stash, no uncommitted row, first parent only
  w.close();
  const w2 = openWorker(d, { showTags: false, showStash: false, showWip: false, firstParent: true });
  const st2 = await w2.done;
  assert.equal(st2.done.rows, 5); // the feature branch tip is its own ref, so its first-parent line shows too
  const r2 = await w2.rows(0, 10);
  assert.ok(!r2.some(r => r.refs.some(x => x.type === 'tag')));
  w2.close();
});

test('search covers the full history: message body, author, path, -S and -G', async () => {
  const { d } = sampleRepo();
  const w = openWorker(d);
  await w.done;
  const idx = async q => (await w.search(q)).rows;
  const rows = await w.rows(0, 10);
  const at = s => rows.findIndex(r => r.subject === s);
  assert.deepEqual(await idx({ mode: 'text', text: 'zebra' }), [at('Feature work')], 'body text found through git --grep');
  assert.ok(w.state.partials >= 1, 'text search answers from memory first');
  assert.ok((await idx({ mode: 'text', text: 'test user' })).length >= 5, 'author');
  assert.deepEqual(await idx({ mode: 'path', text: 'app' }), [at('Feature work'), at('Add app')].sort((a, b) => a - b));
  assert.deepEqual(await idx({ mode: 'content', text: 'haystack' }), [at('Feature work')]);
  assert.deepEqual(await idx({ mode: 'content-regex', text: 'x = [12]' }), [at('Feature work'), at('Add app')].sort((a, b) => a - b));
  const bad = await w.search({ mode: 'text', text: '(', regex: true });
  assert.match(bad.error, /not valid/);
  w.close();
});

function hostileRepo() {
  const d = repo('hostile');
  const marker = path.join(fx.ROOT, 'PWNED-' + path.basename(d));
  const hooks = path.join(d, '.git', 'evilhooks');
  fs.mkdirSync(hooks);
  for (const h of ['post-checkout', 'pre-commit', 'reference-transaction', 'post-index-change', 'pre-auto-gc', 'post-rewrite', 'commit-msg']) {
    fs.writeFileSync(path.join(hooks, h), `#!/bin/sh\necho ${h} >> '${marker}'\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(d, '.git', 'hooks', h), `#!/bin/sh\necho default-${h} >> '${marker}'\n`, { mode: 0o755 });
  }
  commit(d, 'a.secret', 'x\n', 'first');
  commit(d, 'a.secret', 'y\n', 'second');
  fs.writeFileSync(path.join(d, '.gitattributes'), '*.secret diff=evil\n');
  git(d, 'config', 'core.hooksPath', hooks);
  git(d, 'config', 'core.fsmonitor', `touch '${marker}'`);
  git(d, 'config', 'diff.evil.textconv', `touch '${marker}'; cat`);
  git(d, 'config', 'diff.external', `touch '${marker}'`);
  git(d, 'config', 'core.pager', `touch '${marker}'; cat`);
  fs.rmSync(marker, { force: true });
  fs.appendFileSync(path.join(d, 'a.secret'), 'dirty\n');
  return { d, marker };
}

test('hostile repository: no hook, fsmonitor, textconv, external diff or pager runs on read commands', async () => {
  const { d, marker } = hostileRepo();
  const w = openWorker(d);
  const st = await w.done;
  assert.equal(st.error, null);
  assert.equal(st.done.rows, 3);
  const rows = await w.rows(0, 3);
  await w.search({ mode: 'content', text: 'y' });
  await w.search({ mode: 'path', text: 'secret' });
  w.close();
  const head = git(d, 'rev-parse', 'HEAD').trim();
  await details.commitDetails('git', d, head, {});
  await details.workingTreeDetails('git', d, {});
  await details.filesBetween('git', d, 'HEAD~1', 'HEAD', {});
  await fileHistory('git', d, 'a.secret');
  await lineHistory('git', d, 'a.secret', 1, 1);
  const prov = createContentProvider({ vscode: { EventEmitter: class { constructor() { this.event = () => {}; } dispose() {} } }, getGit: () => 'git', settings: () => ({ maxFileMB: 50 }) });
  const text = await prov.provideTextDocumentContent({ query: JSON.stringify({ root: d, ref: head, path: 'a.secret' }) });
  assert.equal(text, 'y\n');
  await repos.discover('git', [d]);
  assert.ok(rows.length === 3);
  assert.equal(fs.existsSync(marker), false, 'a repository program ran: ' + (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : ''));
  // the same commands without our options do run them (proves the fixture is armed)
  git(d, 'status');
  assert.equal(fs.existsSync(marker), true, 'fixture check: plain git status runs fsmonitor');
});

function linear(n, name = 'lin') {
  const d = repo(name);
  const hashes = [];
  for (let i = 1; i <= n; i++) hashes.push(commit(d, `f${i}.txt`, `${i}\n`, `c${i}\n\nbody ${i}`));
  return { d, hashes };
}

test('squash in the middle of a branch gives the same trees and author as git rebase -i on the command line', async () => {
  const a = linear(6, 'sqa');
  const b = path.join(fx.ROOT, 'sqb-' + Date.now());
  git(fx.ROOT, 'clone', '-q', a.d, b);
  // ours: squash c2..c4
  const ins = await rebase.inspectSquash('git', a.d, a.hashes[3], a.hashes[1]);
  assert.equal(ins.ok, true, ins.reason);
  assert.equal(ins.from, 0); assert.equal(ins.to, 2); assert.equal(ins.base, a.hashes[0]);
  const items = rebase.squashItems(ins.commits, ins.from, ins.to, 'Squashed c2 to c4');
  const r = await rebase.runRebase({ git: 'git', cwd: a.d, gitDir: path.join(a.d, '.git'), base: ins.base, items });
  assert.equal(r.ok, true, r.output);
  // CLI: the same squash with fixup lines
  const ed = path.join(fx.ROOT, 'seq.sh');
  fs.writeFileSync(ed, '#!/bin/sh\nsed -i.bak -e "2,3s/^pick/fixup/" "$1"\n', { mode: 0o755 });
  execGit(b, ['rebase', '-i', a.hashes[0]], { GIT_SEQUENCE_EDITOR: ed });
  const tree = (d, rev) => git(d, 'rev-parse', rev + '^{tree}').trim();
  for (const rev of ['HEAD', 'HEAD~1', 'HEAD~2', 'HEAD~3']) assert.equal(tree(a.d, rev), tree(b, rev), rev);
  assert.equal(git(a.d, 'rev-list', '--count', 'HEAD').trim(), '4');
  assert.equal(git(a.d, 'log', '-1', '--format=%s', 'HEAD~2').trim(), 'Squashed c2 to c4');
  assert.equal(git(a.d, 'log', '-1', '--format=%an %at', 'HEAD~2').trim(), git(b, 'log', '-1', '--format=%an %at', 'HEAD~2').trim(), 'author and author date of the oldest commit, as git does');
  assert.equal(git(a.d, 'rev-parse', 'HEAD~3').trim(), a.hashes[0], 'base commit untouched');
  assert.equal(git(a.d, 'status', '--porcelain').trim(), '');
  assert.equal(fs.existsSync(path.join(a.d, '.git', 'rebase-merge')), false);
});

function execGit(cwd, args, env) {
  return require('child_process').execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
}

test('squash at HEAD, reorder + drop + reword with the visual rebase plan', async () => {
  const a = linear(5, 'sqh');
  const ins = await rebase.inspectSquash('git', a.d, a.hashes[2], a.hashes[4]);
  assert.equal(ins.ok, true, ins.reason);
  const r = await rebase.runRebase({ git: 'git', cwd: a.d, gitDir: path.join(a.d, '.git'), base: ins.base, items: rebase.squashItems(ins.commits, ins.from, ins.to, ins.commits.slice(ins.from, ins.to + 1).map(c => c.message).join('\n\n')) });
  assert.equal(r.ok, true, r.output);
  assert.equal(git(a.d, 'rev-list', '--count', 'HEAD').trim(), '3');
  assert.match(git(a.d, 'log', '-1', '--format=%B').trim(), /^c3\n\nbody 3\n\nc4\n\nbody 4\n\nc5\n\nbody 5$/);
  const b = linear(4, 'reo');
  const cs = await rebase.commitsSince('git', b.d, b.hashes[0]);
  const items = [
    { hash: cs[2].hash, action: 'reword', message: cs[2].message, newMessage: 'c4 moved up and renamed' },
    { hash: cs[0].hash, action: 'pick', message: cs[0].message },
    { hash: cs[1].hash, action: 'drop', message: cs[1].message },
  ];
  const r2 = await rebase.runRebase({ git: 'git', cwd: b.d, gitDir: path.join(b.d, '.git'), base: b.hashes[0], items, expect: cs.map(c => c.hash) });
  assert.equal(r2.ok, true, r2.output);
  assert.deepEqual(git(b.d, 'log', '--format=%s').trim().split('\n'), ['c2', 'c4 moved up and renamed', 'c1']);
  assert.equal(fs.existsSync(path.join(b.d, 'f3.txt')), false, 'dropped commit is gone');
});

test('squash refuses: merges, dirty tree, other branch, same commit; sequence check stops a changed list', async () => {
  const { d } = sampleRepo();
  const head = git(d, 'rev-parse', 'HEAD').trim();
  const r1 = await rebase.inspectSquash('git', d, head, git(d, 'rev-parse', 'HEAD~1').trim());
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /uncommitted|merge/);
  const a = linear(3, 'ref');
  assert.match((await rebase.inspectSquash('git', a.d, a.hashes[1], a.hashes[1])).reason, /two different/);
  git(a.d, 'checkout', '-q', '-b', 'other', a.hashes[0]);
  commit(a.d, 'o.txt', 'o\n', 'other work');
  assert.match((await rebase.inspectSquash('git', a.d, a.hashes[1], a.hashes[2])).reason, /checked-out branch/);
  git(a.d, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(a.d, 'f1.txt'), 'changed\n');
  assert.match((await rebase.inspectSquash('git', a.d, a.hashes[1], a.hashes[2])).reason, /uncommitted/);
  git(a.d, 'checkout', '-q', '--', 'f1.txt');
  // the preview listed one commit fewer than git: nothing changes
  const before = git(a.d, 'rev-parse', 'HEAD').trim();
  const cs = await rebase.commitsSince('git', a.d, a.hashes[0]);
  const r = await rebase.runRebase({ git: 'git', cwd: a.d, gitDir: path.join(a.d, '.git'), base: a.hashes[0], items: [{ hash: cs[0].hash, action: 'pick', message: '' }], expect: [cs[0].hash] });
  assert.equal(r.ok, false);
  assert.equal(git(a.d, 'rev-parse', 'HEAD').trim(), before);
  assert.equal(fs.existsSync(path.join(a.d, '.git', 'rebase-merge')), false);
});

test('detached HEAD, a rebase stopped on a conflict, and Unicode/slash branch names', async () => {
  const a = linear(3, 'det');
  git(a.d, 'checkout', '-q', '--detach', a.hashes[1]);
  const w = openWorker(a.d);
  const st = await w.done;
  assert.equal(st.refs.refs.head, null);
  const rows = await w.rows(0, 5);
  assert.ok(rows.find(r => r.hash === a.hashes[1]).refs.some(r => r.type === 'detached'));
  w.close();
  const b = repo('mid');
  commit(b.d || b, 'x.txt', 'base\n', 'base');
  const dir = b.d || b;
  git(dir, 'checkout', '-q', '-b', 'topic');
  commit(dir, 'x.txt', 'topic\n', 'topic change');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'x.txt', 'main\n', 'main change');
  git(dir, 'checkout', '-q', 'topic');
  assert.throws(() => git(dir, 'rebase', 'main'));
  assert.equal(operationFrom(f => fs.existsSync(path.join(dir, '.git', f))), 'rebase');
  const w2 = openWorker(dir);
  const st2 = await w2.done;
  assert.equal(st2.error, null);
  assert.ok(st2.done.rows >= 3);
  w2.close();
  git(dir, 'rebase', '--abort');
  // names with slashes and Unicode: create and check out through the same runner the actions use
  await runGit('git', ['branch', 'team/ß-ü/日本', 'main'], { cwd: dir, write: true });
  await runGit('git', ['checkout', 'team/ß-ü/日本', '--'], { cwd: dir, write: true });
  assert.equal(git(dir, 'branch', '--show-current').trim(), 'team/ß-ü/日本');
});

test('corrupt pack: a clear message, nothing changed', async () => {
  const a = linear(30, 'bad');
  git(a.d, 'gc', '-q');
  const pack = fs.readdirSync(path.join(a.d, '.git', 'objects', 'pack')).find(f => f.endsWith('.pack'));
  const p = path.join(a.d, '.git', 'objects', 'pack', pack);
  fs.chmodSync(p, 0o644);
  const buf = fs.readFileSync(p);
  for (let i = 200; i < buf.length - 40; i += 7) buf[i] ^= 0xff;
  fs.writeFileSync(p, buf);
  const w = openWorker(a.d);
  const st = await w.done;
  w.close();
  const text = st.error ? explainLoadError(st.error.text, st.error.stderr) : '';
  assert.ok(st.error, 'load reports an error');
  assert.match(text, /damaged|could not read|bad|corrupt|inflate|fatal/i);
  assert.match(explainLoadError('fatal: packfile x.pack does not match index', ''), /damaged/);
});

test('large file at a commit: a note instead of loading it; binary note; deleted path is empty', async () => {
  const a = repo('big');
  fs.writeFileSync(path.join(a, 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 65));
  fs.writeFileSync(path.join(a, 'img.dat'), Buffer.from([0, 1, 2, 3, 0, 5]));
  git(a, 'add', '.'); git(a, 'commit', '-q', '-m', 'big');
  const head = git(a, 'rev-parse', 'HEAD').trim();
  const prov = createContentProvider({ vscode: { EventEmitter: class { constructor() { this.event = () => {}; } dispose() {} } }, getGit: () => 'git', settings: () => ({ maxFileMB: 1 }) });
  const q = p => ({ query: JSON.stringify({ root: a, ref: head, path: p }) });
  assert.match(await prov.provideTextDocumentContent(q('big.bin')), /3\.0 MB .* over the 1 MB limit/);
  assert.match(await prov.provideTextDocumentContent(q('img.dat')), /^Binary file, 6 bytes/);
  assert.equal(await prov.provideTextDocumentContent(q('nope.txt')), '');
  const fakeVs = { Uri: { from: o => o } };
  const u = toUri(fakeVs, a, head, 'dir/x y.txt');
  assert.equal(JSON.parse(u.query).path, 'dir/x y.txt');
});

test('commit details, compare, file history across a rename, line history and the branch report', async () => {
  const d = repo('hist');
  commit(d, 'old/name.txt', 'l1\nl2\nl3\n', 'create');
  fs.mkdirSync(path.join(d, 'new'));
  git(d, 'mv', 'old/name.txt', 'new/name.txt'); git(d, 'commit', '-q', '-m', 'rename');
  commit(d, 'new/name.txt', 'l1\nL2 changed\nl3\n', 'edit line 2');
  git(d, 'checkout', '-q', '-b', 'side');
  commit(d, 'side.txt', 's\n', 'side 1');
  commit(d, 'side.txt', 's2\n', 'side 2');
  git(d, 'checkout', '-q', 'main');
  const fh = await fileHistory('git', d, 'new/name.txt');
  assert.deepEqual(fh.map(c => c.subject), ['edit line 2', 'rename', 'create']);
  assert.equal(fh[1].status, 'R');
  assert.equal(fh[1].oldPath, 'old/name.txt');
  const lh = await lineHistory('git', d, 'new/name.txt', 2, 2);
  assert.equal(lh[0].subject, 'edit line 2');
  assert.match(lh[0].patch, /\+L2 changed/);
  const head = git(d, 'rev-parse', 'HEAD').trim();
  const det = await details.commitDetails('git', d, head, {});
  assert.equal(det.files[0].path, 'new/name.txt');
  assert.equal(det.files[0].add, 1);
  const root = git(d, 'rev-list', '--max-parents=0', 'HEAD').trim();
  const rootDet = await details.commitDetails('git', d, root, {});
  assert.equal(rootDet.files[0].status, 'A');
  const cmp = await details.filesBetween('git', d, root, 'side', {});
  assert.ok(cmp.files.some(f => f.path === 'side.txt'));
  const rep = await compareBranches('git', d, 'main', 'side');
  assert.equal(rep.ahead, 2); assert.equal(rep.behind, 0);
  const md = reportMarkdown(rep, new Date(0));
  assert.match(md, /Commits on side only \| 2/);
  assert.match(md, /side 2/);
});

test('discovery: workspace repo, nested repo and an initialised submodule', async () => {
  const sub = linear(2, 'subsrc');
  const top = repo('top');
  commit(top, 'r.txt', 'r\n', 'root');
  git(top, '-c', 'protocol.file.allow=always', 'submodule', '-q', 'add', sub.d, 'libs/sub');
  git(top, 'commit', '-q', '-m', 'add submodule');
  const nested = path.join(top, 'tools', 'inner');
  fs.mkdirSync(nested, { recursive: true });
  git(nested, 'init', '-q', '-b', 'main');
  const found = await repos.discover('git', [top], { depth: 2 });
  const kinds = found.repos.map(r => `${r.label}:${r.kind}`).sort();
  assert.deepEqual(kinds, [`${path.basename(top)}:folder`, `libs${path.sep}sub:submodule`, `tools${path.sep}inner:nested`].sort());
  assert.equal(repos.repoFor(found.repos, path.join(top, 'libs', 'sub', 'f1.txt')).kind, 'submodule');
  assert.equal(repos.repoFor(found.repos, path.join(top, 'r.txt')).kind, 'folder');
});

test('empty repository and a shallow clone load without errors', async () => {
  const e = repo('empty');
  const w = openWorker(e);
  const st = await w.done;
  assert.equal(st.done.empty, true);
  w.close();
  const a = linear(10, 'deep');
  const sh = path.join(fx.ROOT, 'shallow-' + Date.now());
  git(fx.ROOT, 'clone', '-q', '--depth', '3', 'file://' + a.d, sh);
  const w2 = openWorker(sh);
  const st2 = await w2.done;
  assert.equal(st2.done.rows, 3);
  assert.equal(st2.done.openLanes, 0, 'the cut-off commit has no parent lane hanging');
  w2.close();
  const info = await repos.inspect('git', sh);
  assert.equal(info.shallow, true);
});
