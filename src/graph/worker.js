'use strict';
// Worker thread that owns the graph of one repository: it streams `git log` (never the whole output in one
// string), lays out the lanes as rows arrive, keeps the compact row store, answers row windows for the visible part
// of the webview, and runs searches over the whole history. The extension host only relays messages.
const { parentPort, workerData } = require('worker_threads');
const { runGit, streamGit } = require('../git/runner');
const P = require('../git/parse');
const { Store } = require('./store');

const git = workerData.git;
const cwd = workerData.cwd;
let gen = 0;
let store = new Store();
let refs = { heads: [], remotes: [], tags: [], head: null };
let refsByHash = new Map();
let headHash = '';
let stream = null;
let search = null;
let loading = false;
let lastOpts = null;
let revArgs = [];
let lateStatus = null;
const STATUS_WAIT_MS = 1500;

const post = m => parentPort.postMessage(m);

function revisionArgs(o) {
  const a = [];
  if (Array.isArray(o.branches) && o.branches.length) {
    for (const b of o.branches) if (/^refs\//.test(b) || b === 'HEAD') a.push(b);
    if (!a.length) a.push('HEAD');
  } else {
    a.push('--branches');
    if (o.showRemotes !== false) a.push('--remotes');
    if (o.showTags !== false) a.push('--tags');
    if (headHash) a.push('HEAD');
  }
  return a;
}

function buildRefs(r, stashes, o) {
  const m = new Map();
  const put = (h, ref) => { if (!m.has(h)) m.set(h, []); m.get(h).push(ref); };
  for (const h of r.heads) put(h.hash, { type: 'head', name: h.name, current: h.current, upstream: h.upstream, track: h.track });
  if (o.showRemotes !== false) for (const h of r.remotes) put(h.hash, { type: 'remote', name: h.name, remote: h.remote, branch: h.branch });
  if (o.showTags !== false) for (const t of r.tags) put(t.hash, { type: 'tag', name: t.name, annotated: t.annotated });
  if (headHash && !r.head) put(headHash, { type: 'detached', name: 'HEAD' });
  return m;
}

async function load(o) {
  const my = ++gen;
  if (stream) { stream.kill(); stream = null; }
  if (search) { search.kill(); search = null; }
  loading = true;
  lastOpts = o;
  const t0 = Date.now();
  store = new Store();
  const opt = { cwd, timeoutMs: 60000 };
  let stashes = [];
  let status = [];
  let statusSkipped = false;
  try {
    const [refOut, headOut] = await Promise.all([
      runGit(git, ['for-each-ref', '--format=' + P.REF_FORMAT, 'refs/heads', 'refs/remotes', 'refs/tags'], opt),
      runGit(git, ['rev-parse', '--verify', '-q', 'HEAD'], { ...opt, okCodes: [0, 1, 128] }),
    ]);
    headHash = (headOut.stdout.trim().match(P.HASH) || [''])[0];
    refs = P.parseRefs(refOut.stdout);
    if (my !== gen) return;
    const stashP = o.showStash !== false && !o.bare
      ? runGit(git, ['stash', 'list', '-z', '--format=' + P.STASH_FORMAT], opt).then(r => P.parseStashes(r.stdout)).catch(() => [])
      : Promise.resolve([]);
    const hidesHead = Array.isArray(o.branches) && o.branches.length && !o.branches.includes('HEAD') && !(refs.head && o.branches.includes('refs/heads/' + refs.head));
    if (!o.bare && o.showWip !== false && headHash && !hidesHead) {
      if (lateStatus && Date.now() - lateStatus.at < 20000) { status = lateStatus.entries; lateStatus = null; } else {
        // git status runs next to the log: a slow status in a huge working tree must not hold back the first rows
        const statusP = runGit(git, ['status', '--porcelain=v1', '-z', '--untracked-files=' + (o.untracked === false ? 'no' : 'normal'), '--ignore-submodules=dirty'], { cwd, timeoutMs: o.statusTimeoutMs || 15000 })
          .then(r => P.parseStatus(r.stdout));
        const late = Symbol('late');
        const first = await Promise.race([statusP.catch(() => null), new Promise(r => setTimeout(() => r(late), STATUS_WAIT_MS))]);
        if (first === late) {
          statusSkipped = 'late';
          statusP.then(entries => { if (my === gen && entries.length) { lateStatus = { entries, at: Date.now() }; post({ type: 'reloadNeeded', gen: my, reason: 'uncommitted changes' }); } }).catch(() => {});
        } else if (first === null) statusSkipped = true;
        else status = first;
      }
    }
    stashes = await stashP;
  } catch (e) {
    loading = false;
    if (my === gen) post({ type: 'error', gen: my, text: e.message, stderr: e.stderr || '' });
    return;
  }
  if (my !== gen) return;
  refsByHash = buildRefs(refs, stashes, o);
  post({ type: 'refs', gen: my, refs, head: headHash, stashes: stashes.map(s => ({ hash: s.hash, selector: s.selector, subject: s.subject, base: s.base })), status: { count: status.length, skipped: statusSkipped } });

  if (!headHash && !refs.heads.length && !refs.remotes.length && !refs.tags.length) {
    loading = false;
    post({ type: 'done', gen: my, rows: 0, ms: Date.now() - t0, empty: true });
    return;
  }

  // Uncommitted changes row on top, linked to HEAD.
  if (status.length && headHash) {
    store.add({ hash: 'uncommitted', parents: [headHash], author: '', email: '', date: Math.floor(Date.now() / 1000), subject: 'Uncommitted changes' }, 'wip', { count: status.length });
  }
  const stashByBase = new Map();
  for (const s of stashes) { if (!stashByBase.has(s.base)) stashByBase.set(s.base, []); stashByBase.get(s.base).push(s); }

  revArgs = revisionArgs(o);
  const max = Math.max(1000, Math.min(Number(o.maxCommits) || 500000, 5000000));
  const args = ['log', '-z', '--format=' + P.LOG_FORMAT, o.order === 'topo' ? '--topo-order' : '--date-order', '--no-color', '--no-textconv', '--no-ext-diff', '--max-count=' + max];
  if (o.firstParent) args.push('--first-parent');
  args.push(...revArgs, '--');
  const split = P.nulSplitter();
  let lastPost = 0;
  let firstSent = false;
  const addCommit = c => {
    const st = stashByBase.get(c.hash);
    if (st) { for (const s of st) store.add({ hash: s.hash, parents: [s.base], author: s.author, email: '', date: s.date, subject: s.subject }, 'stash', { selector: s.selector }); stashByBase.delete(c.hash); }
    store.add(c, 'commit');
  };
  const onChunk = buf => {
    if (my !== gen) return;
    for (const rec of split.feed(buf)) { const c = P.parseLogRecord(rec); if (c) addCommit(c); }
    const now = Date.now();
    if ((!firstSent && store.rows >= (o.firstBatch || 300)) || (firstSent && now - lastPost > 250)) {
      firstSent = true; lastPost = now;
      post({ type: 'progress', gen: my, rows: store.rows, ms: now - t0, maxLane: store.layout.maxLane });
    }
  };
  stream = streamGit(git, args, { cwd, onChunk });
  try {
    await stream.promise;
  } catch (e) {
    if (my === gen) { loading = false; post({ type: 'error', gen: my, text: e.message, stderr: e.stderr || '', rows: store.rows }); }
    return;
  }
  if (my !== gen) return;
  const tail = split.rest();
  if (tail) { const c = P.parseLogRecord(tail); if (c) addCommit(c); }
  loading = false;
  stream = null;
  post({ type: 'done', gen: my, rows: store.rows, ms: Date.now() - t0, maxLane: store.layout.maxLane, truncated: store.rows >= max, max, bytes: store.bytes(), openLanes: store.layout.openLanes() });
}

async function runSearch(id, q) {
  if (search) { search.kill(); search = null; }
  const t0 = Date.now();
  const mode = q.mode || 'text';
  try {
    if (mode === 'text') {
      const rows = new Set(store.search(q));
      // subjects, authors and hashes answer at once; full message bodies follow from git
      post({ type: 'searchResult', id, rows: [...rows].sort((a, b) => a - b), notLoaded: 0, partial: true, ms: Date.now() - t0 });
      // Full commit messages (subject and body) through git, over the same history as the graph.
      if (q.text && !q.regex) {
        const hashes = await gitHashes(['--grep=' + q.text, '-F', ...(q.caseSensitive ? [] : ['-i'])], id);
        for (const h of hashes) { const r = store.index.get(h); if (r !== undefined) rows.add(r); }
      } else if (q.text && q.regex) {
        const hashes = await gitHashes(['--grep=' + q.text, '-E', ...(q.caseSensitive ? [] : ['-i'])], id);
        for (const h of hashes) { const r = store.index.get(h); if (r !== undefined) rows.add(r); }
      }
      const sorted = [...rows].sort((a, b) => a - b);
      return post({ type: 'searchResult', id, rows: sorted, notLoaded: 0, ms: Date.now() - t0 });
    }
    let extra; let spec = [];
    const t = String(q.text || '');
    if (!t) return post({ type: 'searchResult', id, rows: [], notLoaded: 0, ms: 0 });
    if (mode === 'path') {
      const glob = /[*?[]/.test(t) ? t : `**/*${t}*`;
      spec = [`:(glob${q.caseSensitive ? '' : ',icase'})${glob}`, `:(glob${q.caseSensitive ? '' : ',icase'})${glob}/**`];
      extra = [];
    } else if (mode === 'content') extra = ['-S' + t, ...(q.regex ? ['--pickaxe-regex'] : [])];
    else if (mode === 'content-regex') extra = ['-G' + t];
    else throw new Error('Unknown search mode');
    if (!q.caseSensitive && mode !== 'path') extra.push('--regexp-ignore-case');
    const hashes = await gitHashes(extra, id, spec);
    const rows = []; let notLoaded = 0;
    for (const h of hashes) { const r = store.index.get(h); if (r === undefined) notLoaded++; else rows.push(r); }
    rows.sort((a, b) => a - b);
    post({ type: 'searchResult', id, rows, notLoaded, ms: Date.now() - t0 });
  } catch (e) {
    post({ type: 'searchResult', id, rows: [], error: e.cancelled ? 'Search cancelled.' : e.message, ms: Date.now() - t0 });
  }
}

function gitHashes(extra, id, spec = []) {
  const args = ['log', '-z', '--format=%H', '--no-color', '--no-textconv', '--no-ext-diff', ...(lastOpts && lastOpts.firstParent ? ['--first-parent'] : []), ...extra, ...revArgs, '--', ...spec];
  const split = P.nulSplitter();
  const out = [];
  let n = 0;
  const s = streamGit(git, args, {
    cwd, onChunk: buf => {
      for (const rec of split.feed(buf)) { const h = rec.trim(); if (P.HASH.test(h)) out.push(h); }
      if (++n % 20 === 0) post({ type: 'searchProgress', id, found: out.length });
    },
  });
  search = s;
  return s.promise.then(r => {
    if (search === s) search = null;
    if (r && r.killed) { const e = new Error('cancelled'); e.cancelled = true; throw e; }
    const t = split.rest().trim(); if (P.HASH.test(t)) out.push(t);
    return out;
  });
}

parentPort.on('message', m => {
  try {
    if (m.type === 'load') return void load(m.opts || {}).catch(e => post({ type: 'error', gen, text: e.message }));
    if (m.type === 'rows') return post({ type: 'rows', id: m.id, start: m.start, rows: store.slice(m.start, m.end, refsByHash), total: store.rows, loading });
    if (m.type === 'find') return post({ type: 'found', id: m.id, row: store.find(m.hash) });
    if (m.type === 'search') return void runSearch(m.id, m.query);
    if (m.type === 'cancelSearch') { if (search) { search.kill(); search = null; } return undefined; }
    if (m.type === 'stats') return post({ type: 'stats', id: m.id, rows: store.rows, bytes: store.bytes(), loading, heap: process.memoryUsage().heapUsed });
    if (m.type === 'stop') { gen++; if (stream) stream.kill(); if (search) search.kill(); return undefined; }
  } catch (e) {
    post({ type: 'fail', id: m.id, text: e.message });
  }
  return undefined;
});

