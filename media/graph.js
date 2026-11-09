// Commit Graph webview: virtual scrolling (only the visible rows exist in the page), the graph drawn on a canvas,
// rows fetched from the extension in blocks, full-history search, details, compare and context menus.
// No network, no innerHTML: every text is set with textContent.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const H = 24; // row height in px
  const LW = 14; // lane width in px
  const BLOCK = 200;
  const MAX_PX = 15000000; // scroll height cap; above it the scroll position maps to rows proportionally
  const OVERSCAN = 8;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const $ = id => document.getElementById(id);
  const app = $('app');
  const init = JSON.parse(($('data') || {}).textContent || '{}');

  const S = {
    total: 0, loading: false, cache: new Map(), inflight: new Set(), maxLane: 0, gen: 0, req: 0,
    sel: null, sel2: null, rangeEnd: null, details: null, matches: [], matchSet: new Set(), matchIdx: -1, searchId: 0,
    query: { text: '', mode: 'text', caseSensitive: false, regex: false }, lastSearchKey: '', refs: null, head: '', stashes: [],
    state: { operation: '', stoppedAt: '' }, repos: [], current: '', filter: {}, saved: [], pro: [], dateFormat: 'locale',
    painted: false, openedAt: performance.now(), pendingReveal: init.initial || '', searching: false, loadMs: 0,
  };

  // ---------------------------------------------------------------- layout
  const tb = el('div', 'toolbar');
  const repoSel = el('select'); repoSel.title = 'Repository'; repoSel.setAttribute('aria-label', 'Repository');
  const branchBtn = el('button', '', 'Branches: All'); branchBtn.title = 'Choose which branches to show';
  const tog = (label, key, title) => { const l = el('label', 'tog'); const c = el('input'); c.type = 'checkbox'; c.dataset.key = key; l.title = title; l.append(c, document.createTextNode(label)); c.addEventListener('change', () => send({ type: 'filter', filter: { [key]: c.checked } })); return l; };
  const tRemote = tog('Remotes', 'showRemotes', 'Show remote branches');
  const tTags = tog('Tags', 'showTags', 'Show tags');
  const tStash = tog('Stashes', 'showStash', 'Show stashes');
  const tFirst = tog('First parent', 'firstParent', 'Follow only the first parent of merges (git log --first-parent)');
  const search = el('div', 'search');
  const modeSel = el('select'); modeSel.title = 'What to search';
  for (const [v, t] of [['text', 'Message, author, hash'], ['path', 'File path'], ['content', 'Changed text (-S)'], ['content-regex', 'Changed lines regex (-G)']]) { const o = el('option', '', t); o.value = v; modeSel.append(o); }
  const q = el('input'); q.type = 'text'; q.placeholder = 'Search all history (Enter)'; q.setAttribute('aria-label', 'Search all history');
  const caseBtn = el('button', 'icon', 'Aa'); caseBtn.title = 'Match case';
  const reBtn = el('button', 'icon', '.*'); reBtn.title = 'Regular expression';
  const prevBtn = el('button', 'icon', '↑'); prevBtn.title = 'Previous match (Shift+Enter)';
  const nextBtn = el('button', 'icon', '↓'); nextBtn.title = 'Next match (Enter)';
  const count = el('span', 'count', '');
  const stopBtn = el('button', 'icon', '×'); stopBtn.title = 'Stop the search'; stopBtn.style.display = 'none';
  search.append(modeSel, q, caseBtn, reBtn, prevBtn, nextBtn, count, stopBtn);
  const savedSel = el('select'); savedSel.title = 'Saved filters';
  const saveBtn = el('button', '', 'Save Filter'); saveBtn.title = 'Save the branch filter and view options';
  const cmpBtn = el('button', '', 'Compare Branches'); cmpBtn.title = 'Report: commits and files between two branches';
  const fetchBtn = el('button', '', 'Fetch'); fetchBtn.title = 'git fetch --all --prune (asks first)';
  const pullBtn = el('button', '', 'Pull'); pullBtn.title = 'git pull --ff-only (asks first)';
  const pushBtn = el('button', '', 'Push'); pushBtn.title = 'git push (asks first)';
  const refreshBtn = el('button', '', 'Refresh'); refreshBtn.title = 'Reload the graph';
  tb.append(repoSel, branchBtn, tRemote, tTags, tStash, tFirst, el('span', 'sep'), search, el('span', 'spacer'), savedSel, saveBtn, cmpBtn, el('span', 'sep'), fetchBtn, pullBtn, pushBtn, refreshBtn);

  const banner = el('div'); banner.id = 'banner';
  const status = el('div', 'status');
  const stLeft = el('span', '', ''); const stRight = el('span', '', '');
  status.append(stLeft, stRight);
  const header = el('div', 'header');
  for (const t of ['Graph', 'Description', 'Date', 'Author', 'Commit']) header.append(el('div', '', t));
  const scroller = el('div'); scroller.id = 'scroller'; scroller.tabIndex = 0; scroller.setAttribute('role', 'grid'); scroller.setAttribute('aria-label', 'Commits');
  const spacer = el('div'); spacer.id = 'spacer';
  const view = el('div'); view.id = 'view';
  const canvas = el('canvas'); canvas.id = 'graph';
  const rowsEl = el('div'); rowsEl.id = 'rows';
  view.append(rowsEl, canvas); spacer.append(view); scroller.append(spacer); // canvas on top: selected rows have opaque backgrounds
  const emptyEl = el('div', 'empty', 'Loading…');
  const det = el('div'); det.id = 'details';
  const resizer = el('div'); resizer.id = 'resizer';
  const dhead = el('div'); dhead.id = 'dhead';
  const dbody = el('div'); dbody.id = 'dbody';
  const dmeta = el('div'); dmeta.id = 'dmeta';
  const dfiles = el('div'); dfiles.id = 'dfiles';
  dbody.append(dmeta, dfiles); det.append(resizer, dhead, dbody);
  const menu = el('div'); menu.id = 'menu'; menu.setAttribute('role', 'menu');
  app.append(tb, banner, status, header, scroller, emptyEl, det);
  document.body.append(menu);
  scroller.style.display = 'none';

  function send(m) { vscode.postMessage(m); }
  const proMark = name => (S.pro.includes(name) ? ' Pro' : '');

  // ---------------------------------------------------------------- colours
  const COLOR_VARS = ['--vscode-charts-blue', '--vscode-charts-red', '--vscode-charts-green', '--vscode-charts-yellow', '--vscode-charts-purple', '--vscode-charts-orange',
    '--vscode-terminal-ansiCyan', '--vscode-terminal-ansiMagenta', '--vscode-terminal-ansiBrightBlue', '--vscode-terminal-ansiBrightGreen', '--vscode-terminal-ansiBrightRed', '--vscode-terminal-ansiBrightYellow'];
  const FALLBACK = ['#3794ff', '#f14c4c', '#89d185', '#cca700', '#b180d7', '#d18616', '#29b8db', '#bc3fbc', '#3b8eea', '#23d18b', '#f14c4c', '#f5f543'];
  let palette = FALLBACK; let fg = '#ccc'; let bg = '#1e1e1e';
  function readColors() {
    const cs = getComputedStyle(document.body);
    palette = COLOR_VARS.map((v, i) => cs.getPropertyValue(v).trim() || FALLBACK[i]);
    fg = cs.getPropertyValue('--vscode-foreground').trim() || fg;
    bg = cs.getPropertyValue('--vscode-editor-background').trim() || bg;
  }
  readColors();
  new MutationObserver(() => { readColors(); render(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // ---------------------------------------------------------------- formatting
  const rtf = typeof Intl !== 'undefined' && Intl.RelativeTimeFormat ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;
  const dtf = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  function fmtDate(sec) {
    if (!sec) return '';
    const d = new Date(sec * 1000);
    if (S.dateFormat === 'iso') return d.toISOString().slice(0, 16).replace('T', ' ');
    if (S.dateFormat === 'relative' && rtf) {
      const diff = (sec * 1000 - Date.now()) / 1000;
      const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
      for (const [u, s] of units) if (Math.abs(diff) >= s) return rtf.format(Math.round(diff / s), u);
      return rtf.format(Math.round(diff), 'second');
    }
    return dtf.format(d);
  }
  const short = h => String(h || '').slice(0, 8);

  // ---------------------------------------------------------------- virtual scroll
  function rowPx() { const full = S.total * H; return full > MAX_PX ? MAX_PX / S.total : H; }
  function setTotal(n) {
    S.total = n;
    spacer.style.height = Math.max(0, Math.min(n * H, MAX_PX)) + 'px';
    const empty = n === 0;
    scroller.style.display = empty ? 'none' : '';
    emptyEl.style.display = empty ? '' : 'none';
  }
  function visibleRange() {
    const rp = rowPx();
    const firstF = scroller.scrollTop / rp;
    const first = Math.floor(firstF);
    const n = Math.ceil(scroller.clientHeight / H) + 1;
    return { first, firstF, n, offset: -(firstF - first) * H };
  }
  function ensureRows(a, b) {
    a = Math.max(0, a); b = Math.min(S.total, b);
    for (let s = Math.floor(a / BLOCK) * BLOCK; s < b; s += BLOCK) {
      const e = Math.min(s + BLOCK, S.total);
      let missing = false;
      for (let i = s; i < e; i++) if (!S.cache.has(i)) { missing = true; break; }
      const key = S.gen + ':' + s + ':' + e;
      if (missing && !S.inflight.has(key)) { S.inflight.add(key); send({ type: 'rows', start: s, end: e, req: key }); }
    }
  }

  let raf = 0;
  function render() { if (!raf) raf = requestAnimationFrame(draw); }

  function laneX(l) { return 8 + l * LW; }
  function graphWidth() { return Math.round(Math.max(40, Math.min((S.maxLane + 1) * LW + 12, Math.max(90, window.innerWidth * 0.34)))); }

  function draw() {
    raf = 0;
    if (!S.total) return;
    const { first, n, offset } = visibleRange();
    const a = Math.max(0, first - OVERSCAN); const b = Math.min(S.total, first + n + OVERSCAN);
    ensureRows(a - BLOCK, b + BLOCK);
    const gw = graphWidth();
    document.documentElement.style.setProperty('--gw', gw + 'px');
    view.style.transform = `translateY(${scroller.scrollTop + offset - (first - a) * H}px)`;
    // rows
    const frag = document.createDocumentFragment();
    let missing = 0;
    for (let i = a; i < b; i++) {
      const r = S.cache.get(i);
      frag.append(r ? rowEl(r) : placeholder(i));
      if (!r) missing++;
    }
    rowsEl.replaceChildren(frag);
    drawGraph(a, b, gw);
    if (!S.painted && missing === 0 && b > a) { S.painted = true; document.body.dataset.firstPaintMs = String(Math.round(performance.now() - S.loadStart)); send({ type: 'painted', rows: S.total }); }
    document.body.dataset.firstRow = String(first);
  }

  function placeholder(i) { const d = el('div', 'row'); d.dataset.i = i; d.append(el('div'), el('div', 'subj', '…')); return d; }

  function rowEl(r) {
    const d = el('div', 'row');
    d.dataset.i = r.i;
    d.setAttribute('role', 'row');
    if (r.kind !== 'commit') d.classList.add(r.kind);
    if (S.sel && S.sel.i === r.i) d.classList.add('sel');
    if (S.sel2 && S.sel2.i === r.i) d.classList.add('sel2');
    if (S.sel && S.rangeEnd != null && r.i !== S.sel.i && inRange(r.i)) d.classList.add('range');
    if (S.matchSet.has(r.i)) d.classList.add('match');
    if (S.matchIdx >= 0 && S.matches[S.matchIdx] === r.i) d.classList.add('cur');
    const g = el('div');
    const desc = el('div', 'desc');
    for (const ref of r.refs || []) desc.append(refEl(ref, r));
    if (r.kind === 'stash' && r.extra) { const b = el('span', 'ref stash', r.extra.selector); b.title = 'Stash ' + r.extra.selector; desc.append(b); }
    const subj = el('span', 'subj');
    const text = r.kind === 'wip' ? `Uncommitted changes (${r.extra ? r.extra.count : 0})` : r.subject;
    highlight(subj, text);
    desc.append(subj);
    desc.title = text;
    const date = el('div', 'date', r.kind === 'wip' ? '' : fmtDate(r.date));
    const author = el('div', 'author', r.author || '');
    author.title = r.email ? `${r.author} <${r.email}>` : '';
    const hash = el('div', 'hash', r.kind === 'wip' ? '*' : short(r.hash));
    d.append(g, desc, date, author, hash);
    return d;
  }

  function highlight(node, text) {
    const t = S.query.text;
    if (!t || S.query.mode !== 'text' || S.query.regex || !S.matchSet.size) { node.textContent = text; return; }
    const hay = S.query.caseSensitive ? text : text.toLowerCase();
    const needle = S.query.caseSensitive ? t : t.toLowerCase();
    let i = 0; let j;
    while ((j = hay.indexOf(needle, i)) >= 0 && needle) {
      if (j > i) node.append(document.createTextNode(text.slice(i, j)));
      node.append(el('mark', '', text.slice(j, j + needle.length)));
      i = j + needle.length;
    }
    if (i < text.length) node.append(document.createTextNode(text.slice(i)));
  }

  function refEl(ref, row) {
    const b = el('span', 'ref ' + ref.type + (ref.current ? ' current' : ''), ref.type === 'tag' ? '◆ ' + ref.name : ref.name);
    b.title = ref.type === 'head' ? `Branch ${ref.name}${ref.current ? ' (checked out)' : ''}${ref.upstream ? ` · tracks ${ref.upstream} ${ref.track || ''}` : ''}` : ref.type === 'remote' ? `Remote branch ${ref.name}` : ref.type === 'tag' ? `Tag ${ref.name}` : 'Detached HEAD';
    b.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); select(row.i, {}); refMenu(e, ref, row); });
    b.addEventListener('dblclick', e => { e.stopPropagation(); if (ref.type === 'head' && !ref.current) act('checkout', { ref: ref.name }); else if (ref.type === 'remote') act('checkoutRemote', { ref: ref.name, branch: ref.branch, localExists: localExists(ref.branch) }); });
    return b;
  }

  function localExists(name) { return !!(S.refs && S.refs.heads.some(h => h.name === name)); }

  function drawGraph(a, b, gw) {
    const dpr = window.devicePixelRatio || 1;
    const h = (b - a) * H;
    if (canvas.width !== Math.round(gw * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(gw * dpr); canvas.height = Math.round(h * dpr);
      canvas.style.width = gw + 'px'; canvas.style.height = h + 'px';
    }
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, gw, h);
    c.lineWidth = 2;
    c.lineCap = 'round';
    c.save();
    c.beginPath(); c.rect(0, 0, gw - 4, h); c.clip();
    for (let i = a; i < b; i++) {
      const r = S.cache.get(i);
      if (!r || !r.g) continue;
      const y = (i - a) * H; const m = y + H / 2; const g = r.g;
      const xc = laneX(g.col);
      for (const [l, col] of g.pass) line(c, palette[col % palette.length], laneX(l), y, laneX(l), y + H);
      for (const [l, col] of g.ins) curve(c, palette[col % palette.length], laneX(l), y, xc, m, true);
      for (const [l, col] of g.outs) curve(c, palette[col % palette.length], xc, m, laneX(l), y + H, false);
    }
    for (let i = a; i < b; i++) {
      const r = S.cache.get(i);
      if (!r || !r.g) continue;
      const y = (i - a) * H + H / 2;
      node(c, r, laneX(r.g.col), y, palette[r.g.color % palette.length]);
    }
    c.restore();
  }

  function line(c, color, x1, y1, x2, y2) { c.strokeStyle = color; c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); }
  function curve(c, color, x1, y1, x2, y2, into) {
    c.strokeStyle = color; c.beginPath(); c.moveTo(x1, y1);
    if (x1 === x2) c.lineTo(x2, y2);
    else if (into) c.bezierCurveTo(x1, y1 + (y2 - y1) * 0.7, x2, y1 + (y2 - y1) * 0.3, x2, y2);
    else c.bezierCurveTo(x1, y1 + (y2 - y1) * 0.7, x2, y1 + (y2 - y1) * 0.3, x2, y2);
    c.stroke();
  }
  function node(c, r, x, y, color) {
    const isHead = r.hash === S.head && r.kind === 'commit';
    c.lineWidth = 2;
    if (r.kind === 'wip') {
      c.setLineDash([2, 2]); c.strokeStyle = color; c.fillStyle = bg; c.beginPath(); c.arc(x, y, 5, 0, Math.PI * 2); c.fill(); c.stroke(); c.setLineDash([]);
      return;
    }
    if (r.kind === 'stash') { c.fillStyle = bg; c.strokeStyle = color; c.beginPath(); c.rect(x - 4.5, y - 4.5, 9, 9); c.fill(); c.stroke(); return; }
    if (isHead) { c.fillStyle = bg; c.strokeStyle = color; c.lineWidth = 3; c.beginPath(); c.arc(x, y, 6, 0, Math.PI * 2); c.fill(); c.stroke(); c.fillStyle = color; c.beginPath(); c.arc(x, y, 2.5, 0, Math.PI * 2); c.fill(); c.lineWidth = 2; return; }
    if (r.parents && r.parents.length > 1) { c.fillStyle = color; c.beginPath(); c.arc(x, y, 5, 0, Math.PI * 2); c.fill(); c.fillStyle = bg; c.beginPath(); c.arc(x, y, 2, 0, Math.PI * 2); c.fill(); return; }
    c.fillStyle = color; c.beginPath(); c.arc(x, y, 4.5, 0, Math.PI * 2); c.fill();
  }

  scroller.addEventListener('scroll', render, { passive: true });
  window.addEventListener('resize', render);

  // ---------------------------------------------------------------- selection and details
  function inRange(i) { if (!S.sel || S.rangeEnd == null) return false; const lo = Math.min(S.sel.i, S.rangeEnd); const hi = Math.max(S.sel.i, S.rangeEnd); return i >= lo && i <= hi; }
  function rowAt(target) { const r = target.closest && target.closest('.row'); return r ? Number(r.dataset.i) : -1; }

  rowsEl.addEventListener('click', e => {
    const i = rowAt(e.target); if (i < 0) return;
    if (e.shiftKey && S.sel) { S.rangeEnd = i; S.sel2 = null; render(); showRangeInfo(); return; }
    if ((e.ctrlKey || e.metaKey) && S.sel && S.sel.i !== i) { S.sel2 = { i, row: S.cache.get(i) }; S.rangeEnd = null; render(); compareSelected(); return; }
    select(i, { details: true });
  });
  rowsEl.addEventListener('dblclick', e => { const i = rowAt(e.target); if (i >= 0) select(i, { details: true }); });
  rowsEl.addEventListener('contextmenu', e => { e.preventDefault(); const i = rowAt(e.target); if (i < 0) return; if (!S.sel || (S.sel.i !== i && !inRange(i) && !(S.sel2 && S.sel2.i === i))) select(i, {}); rowMenu(e, S.cache.get(i)); });

  function select(i, { details = false, scroll = false } = {}) {
    const row = S.cache.get(i);
    S.sel = { i, hash: row ? row.hash : '', row }; S.sel2 = null; S.rangeEnd = null;
    if (scroll) scrollTo(i);
    render();
    if (details && row) openDetails(row);
    else if (det.classList.contains('show') && row) openDetails(row);
  }

  function scrollTo(i) {
    const rp = rowPx();
    const top = i * rp; const vh = scroller.clientHeight;
    if (top < scroller.scrollTop + H || top > scroller.scrollTop + vh - 3 * H) scroller.scrollTop = Math.max(0, top - vh / 3);
  }

  function clearDetails(title) { dhead.replaceChildren(); dmeta.replaceChildren(); dfiles.replaceChildren(); const t = el('span', 't', title); const x = el('button', 'icon', '×'); x.title = 'Close (Escape)'; x.addEventListener('click', closeDetails); dhead.append(t, x); det.classList.add('show'); render(); }
  function closeDetails() { det.classList.remove('show'); S.details = null; render(); }

  function openDetails(row, parent) {
    const req = ++S.req;
    S.details = { req, row };
    clearDetails(row.kind === 'wip' ? 'Uncommitted changes' : row.subject);
    dfiles.append(el('div', 'note', 'Loading…'));
    send({ type: 'details', req, hash: row.hash, kind: row.kind, parent });
  }

  function showDetails(m) {
    if (!S.details || S.details.req !== m.req) return;
    const row = S.details.row;
    dfiles.replaceChildren(); dmeta.replaceChildren();
    if (m.error) { dmeta.append(el('div', 'note', m.error)); return; }
    const d = m.data;
    if (row.kind === 'wip') {
      dmeta.append(el('div', '', `${d.totalFiles} changed file${d.totalFiles === 1 ? '' : 's'} compared with HEAD.`));
      if (d.conflicts && d.conflicts.length) dmeta.append(el('div', 'note', `${d.conflicts.length} file(s) with conflicts.`));
      const acts = el('div', 'acts');
      acts.append(button('Stash Changes…', () => act('stashPush', {})), button('Open Source Control', () => send({ type: 'command', command: 'workbench.view.scm' })));
      dmeta.append(acts);
      fileList(d.files, d.totalFiles, 'HEAD', 'WORKTREE');
      return;
    }
    const t = el('table');
    const tr = (k, v) => { const r = el('tr'); const a = el('td', '', k); const b = el('td'); if (v instanceof Node) b.append(v); else b.textContent = v; r.append(a, b); t.append(r); };
    const hashLine = el('span'); hashLine.append(el('span', '', d.hash + ' '), link('copy', () => send({ type: 'copy', text: d.hash })));
    tr('Commit', hashLine);
    if (d.parents.length) {
      const ps = el('span');
      d.parents.forEach((p, k) => { if (k) ps.append(document.createTextNode(', ')); ps.append(link(short(p), () => reveal(p))); });
      tr(d.parents.length > 1 ? 'Parents' : 'Parent', ps);
    }
    tr('Author', `${d.author} <${d.email}>  ·  ${fmtDate(d.date)}`);
    if (d.committer !== d.author || d.cdate !== d.date) tr('Committer', `${d.committer} <${d.committerEmail}>  ·  ${fmtDate(d.cdate)}`);
    if (row.refs && row.refs.length) tr('Refs', row.refs.map(r => r.name).join(', '));
    if (row.kind === 'stash' && row.extra) tr('Stash', row.extra.selector);
    dmeta.append(t);
    const msg = el('div', 'msg', d.message);
    dmeta.append(msg);
    const acts = el('div', 'acts');
    if (row.kind === 'stash') acts.append(button('Apply', () => act('stashApply', { ref: row.extra.selector })), button('Pop', () => act('stashPop', { ref: row.extra.selector })), button('Drop', () => act('stashDrop', { ref: row.extra.selector })));
    else acts.append(button('Compare with Working Tree', () => compareWith(d.hash, 'WORKTREE')), button('Check Out…', () => act('checkoutCommit', { hash: d.hash })), button('Create Branch…', () => act('createBranch', { hash: d.hash })));
    dmeta.append(acts);
    if (d.parents.length > 1) {
      const pick = el('select'); pick.title = 'Files compared with this parent';
      d.parents.forEach((p, k) => { const o = el('option', '', `Changes compared with parent ${k + 1} (${short(p)})`); o.value = p; if (p === d.comparedTo) o.selected = true; pick.append(o); });
      pick.addEventListener('change', () => openDetails(row, pick.value));
      const w = el('div', 'note'); w.append(pick); dfiles.append(w);
    }
    fileList(d.files, d.totalFiles, d.comparedTo, d.hash, row.kind === 'stash' ? d.parents : null);
  }

  function fileList(files, total, a, b) {
    if (!files.length) { dfiles.append(el('div', 'note', 'No changed files.')); return; }
    if (total > files.length) dfiles.append(el('div', 'note', `Showing ${files.length.toLocaleString()} of ${total.toLocaleString()} files (setting zovoGit.maxFilesInDetails).`));
    const frag = document.createDocumentFragment();
    for (const f of files) {
      const r = el('div', 'file'); r.setAttribute('role', 'button'); r.tabIndex = 0;
      const st = el('span', 'st ' + f.status, f.untracked && b === 'WORKTREE' ? 'U' : f.status);
      st.title = { A: 'Added', D: 'Deleted', M: 'Modified', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Untracked' }[f.untracked && b === 'WORKTREE' ? 'U' : f.status] || f.status;
      const p = el('span', 'p');
      const slash = f.path.lastIndexOf('/');
      p.append(el('span', '', slash >= 0 ? f.path.slice(slash + 1) : f.path));
      const dir = (slash >= 0 ? ' ' + f.path.slice(0, slash) : '') + (f.oldPath && f.oldPath !== f.path ? `  ← ${f.oldPath}` : '');
      if (dir) p.append(el('span', 'dir', dir));
      p.title = f.path;
      const n = el('span', 'n');
      if (f.add != null && f.add >= 0) { n.append(el('span', 'a', '+' + f.add), document.createTextNode(' '), el('span', 'd', '−' + f.del)); } else if (f.add === -1) n.textContent = 'binary';
      const fa = el('span', 'fa');
      const left = f.at ? null : a;
      const right = f.at || b;
      if (f.status !== 'D' && right !== 'WORKTREE') fa.append(button('Open', ev => { ev.stopPropagation(); send({ type: 'openFile', path: f.path, ref: right }); }, 'Open the file as it was at this commit'));
      if (f.status !== 'D') fa.append(button('Working', ev => { ev.stopPropagation(); send({ type: 'openWorking', path: f.path }); }, 'Open the file in the working tree'));
      fa.append(button('History', ev => { ev.stopPropagation(); send({ type: 'fileHistory', path: f.path }); }, 'File history'));
      if (staged(f)) st.title += ' (staged)';
      r.append(st, p, fa, n);
      const open = () => send({ type: 'openDiff', path: f.path, oldPath: f.oldPath, status: f.untracked && !f.at ? 'U' : f.status, a: left, b: right });
      r.addEventListener('click', open);
      r.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
      frag.append(r);
    }
    dfiles.append(frag);
  }
  function staged(f) { return !!f.staged; }

  function compareWith(a, b) {
    const req = ++S.req;
    S.details = { req, compare: true };
    clearDetails(`Compare ${short(a)} ↔ ${b === 'WORKTREE' ? 'working tree' : short(b)}`);
    dfiles.append(el('div', 'note', 'Loading…'));
    send({ type: 'compare', req, a, b });
  }
  function compareSelected() {
    const r1 = S.sel && S.sel.row; const r2 = S.sel2 && S.sel2.row;
    if (!r1 || !r2) return;
    // older one on the left: higher row index is older
    const [older, newer] = r1.i > r2.i ? [r1, r2] : [r2, r1];
    compareWith(older.kind === 'wip' ? 'HEAD' : older.hash, newer.kind === 'wip' ? 'WORKTREE' : newer.hash);
  }
  function showCompare(m) {
    if (!S.details || S.details.req !== m.req) return;
    dfiles.replaceChildren(); dmeta.replaceChildren();
    if (m.error) { dmeta.append(el('div', 'note', m.error)); return; }
    dmeta.append(el('div', '', `${m.data.total.toLocaleString()} file${m.data.total === 1 ? '' : 's'} differ between ${short(m.a)} and ${m.b === 'WORKTREE' ? 'the working tree' : short(m.b)}.`));
    dmeta.append(el('div', 'note', 'Click a file to open the VS Code diff.'));
    fileList(m.data.files, m.data.total, m.a, m.b);
  }
  function showRangeInfo() {
    const lo = Math.min(S.sel.i, S.rangeEnd); const hi = Math.max(S.sel.i, S.rangeEnd);
    clearDetails(`${hi - lo + 1} commits selected`);
    dmeta.append(el('div', '', 'Shift+click selected a range. Squash joins them into one commit, with a preview first.'));
    const acts = el('div', 'acts');
    acts.append(button('Squash These Commits…', () => squashRange(), '', 'primary'));
    const a = S.cache.get(hi); const b = S.cache.get(lo);
    if (a && b) acts.append(button('Compare Oldest ↔ Newest', () => compareWith(a.parents[0] || a.hash, b.hash)));
    dmeta.append(acts);
  }
  function squashRange() {
    const lo = Math.min(S.sel.i, S.rangeEnd); const hi = Math.max(S.sel.i, S.rangeEnd);
    const a = S.cache.get(hi); const b = S.cache.get(lo);
    if (!a || !b) return;
    act('squash', { a: a.hash, b: b.hash });
  }

  function button(text, fn, title, cls) { const b = el('button', cls || '', text); if (title) b.title = title; b.addEventListener('click', fn); return b; }
  function link(text, fn) { const a = el('a', 'link', text); a.tabIndex = 0; a.addEventListener('click', fn); a.addEventListener('keydown', e => { if (e.key === 'Enter') fn(); }); return a; }

  function stateInfo() {
    const cur = S.refs && S.refs.heads.find(h => h.current);
    const remotes = S.refs ? [...new Set(S.refs.remotes.map(r => r.remote))] : [];
    return { branch: cur ? cur.name : '', upstream: cur ? cur.upstream : '', remotes };
  }
  function act(name, args) { hideMenu(); send({ type: 'action', name, ...args, state: stateInfo() }); }

  // ---------------------------------------------------------------- menus
  let menuItems = [];
  function showMenu(e, items) {
    menu.replaceChildren(); menuItems = [];
    for (const it of items) {
      if (it === '-') { menu.append(el('div', 'ms')); continue; }
      if (it.header) { menu.append(el('div', 'mh', it.header)); continue; }
      const d = el('div', 'mi', it.label + (it.pro ? proMark(it.pro) : '')); d.setAttribute('role', 'menuitem'); d.tabIndex = -1;
      d.addEventListener('click', () => { hideMenu(); it.run(); });
      menu.append(d); menuItems.push(d);
    }
    menu.classList.add('show');
    const w = menu.offsetWidth; const h = menu.offsetHeight;
    menu.style.left = Math.min(e.clientX, window.innerWidth - w - 4) + 'px';
    menu.style.top = Math.max(0, Math.min(e.clientY, window.innerHeight - h - 4)) + 'px';
    if (menuItems[0]) { menuItems[0].classList.add('focus'); menuItems[0].focus(); }
  }
  function hideMenu() { menu.classList.remove('show'); }
  document.addEventListener('click', e => { if (!menu.contains(e.target)) hideMenu(); });
  menu.addEventListener('keydown', e => {
    const i = menuItems.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = (i + (e.key === 'ArrowDown' ? 1 : -1) + menuItems.length) % menuItems.length; menuItems.forEach(x => x.classList.remove('focus')); menuItems[n].classList.add('focus'); menuItems[n].focus(); }
    if (e.key === 'Enter' && i >= 0) menuItems[i].click();
    if (e.key === 'Escape') { hideMenu(); scroller.focus(); }
  });

  function rowMenu(e, r) {
    if (!r) return;
    const items = [];
    if (r.kind === 'wip') {
      items.push({ label: 'Stash Changes…', run: () => act('stashPush', {}) }, { label: 'Open Source Control', run: () => send({ type: 'command', command: 'workbench.view.scm' }) }, { label: 'Show Changes', run: () => select(r.i, { details: true }) });
      return showMenu(e, items);
    }
    if (r.kind === 'stash') {
      const s = r.extra.selector;
      items.push({ header: s }, { label: 'Apply Stash…', run: () => act('stashApply', { ref: s }) }, { label: 'Pop Stash…', run: () => act('stashPop', { ref: s }) }, { label: 'Drop Stash…', run: () => act('stashDrop', { ref: s }) }, '-', { label: 'Copy Stash Name', run: () => send({ type: 'copy', text: s }) });
      return showMenu(e, items);
    }
    const isMerge = r.parents.length > 1;
    const cur = stateInfo().branch;
    if (S.rangeEnd != null && inRange(r.i)) {
      const n = Math.abs(S.rangeEnd - S.sel.i) + 1;
      items.push({ label: `Squash ${n} Selected Commits…`, run: squashRange }, '-');
    }
    if (S.sel2 && (S.sel2.i === r.i || S.sel.i === r.i)) items.push({ label: 'Compare the Two Selected Commits', run: compareSelected }, '-');
    items.push(
      { header: `${short(r.hash)} ${r.subject.slice(0, 50)}` },
      { label: 'Check Out This Commit…', run: () => act('checkoutCommit', { hash: r.hash }) },
      { label: 'Create Branch Here…', run: () => act('createBranch', { hash: r.hash }) },
      { label: 'Create Tag Here…', run: () => act('createTag', { hash: r.hash }) },
      '-',
      { label: `Merge into ${cur || 'HEAD'}…`, run: () => act('merge', { ref: r.hash }) },
      { label: `Rebase ${cur || 'HEAD'} onto This Commit…`, run: () => act('rebase', { ref: r.hash }) },
      { label: 'Cherry-pick…', run: () => act('cherryPick', { hash: r.hash, isMerge }) },
      { label: 'Revert…', run: () => act('revert', { hash: r.hash, isMerge }) },
      { label: `Reset ${cur || 'HEAD'} to Here…`, run: () => act('reset', { hash: r.hash }) },
      { label: 'Interactive Rebase from Here…', pro: 'Interactive rebase editor', run: () => act('interactiveRebase', { hash: r.hash }) },
      '-',
      { label: 'Compare with Working Tree', run: () => compareWith(r.hash, 'WORKTREE') },
      { label: 'Copy Hash', run: () => send({ type: 'copy', text: r.hash }) },
      { label: 'Copy Subject', run: () => send({ type: 'copy', text: r.subject }) },
    );
    showMenu(e, items);
  }

  function refMenu(e, ref, row) {
    const cur = stateInfo().branch;
    const items = [{ header: ref.name }];
    if (ref.type === 'head') {
      if (!ref.current) items.push({ label: 'Check Out…', run: () => act('checkout', { ref: ref.name }) });
      if (!ref.current) items.push({ label: `Merge into ${cur || 'HEAD'}…`, run: () => act('merge', { ref: ref.name }) }, { label: `Rebase ${cur || 'HEAD'} onto ${ref.name}…`, run: () => act('rebase', { ref: ref.name }) });
      items.push({ label: 'Rename…', run: () => act('renameBranch', { ref: ref.name }) });
      if (!ref.current) items.push({ label: 'Delete…', run: () => act('deleteBranch', { ref: ref.name }) });
      if (ref.current) items.push({ label: 'Push…', run: () => act('push', {}) }, { label: 'Pull (fast-forward only)…', run: () => act('pull', {}) });
      if (!ref.current && cur) items.push('-', { label: `Compare with ${cur} (report)`, pro: 'Branch comparison report', run: () => act('compareBranches', { a: cur, b: ref.name }) });
    } else if (ref.type === 'remote') {
      items.push({ label: 'Check Out as Local Branch…', run: () => act('checkoutRemote', { ref: ref.name, branch: ref.branch, localExists: localExists(ref.branch) }) },
        { label: `Merge into ${cur || 'HEAD'}…`, run: () => act('merge', { ref: ref.name }) },
        { label: `Rebase ${cur || 'HEAD'} onto ${ref.name}…`, run: () => act('rebase', { ref: ref.name }) },
        { label: 'Delete on Remote…', run: () => act('deleteRemoteBranch', { remote: ref.remote, branch: ref.branch }) });
      if (cur) items.push('-', { label: `Compare with ${cur} (report)`, pro: 'Branch comparison report', run: () => act('compareBranches', { a: cur, b: ref.name }) });
    } else if (ref.type === 'tag') {
      items.push({ label: 'Delete Tag…', run: () => act('deleteTag', { ref: ref.name }) }, { label: 'Push Tag…', run: () => act('pushTag', { ref: ref.name }) }, { label: `Merge into ${cur || 'HEAD'}…`, run: () => act('merge', { ref: ref.name }) });
    } else {
      items.push({ label: 'Create Branch Here…', run: () => act('createBranch', { hash: row.hash }) });
    }
    items.push('-', { label: 'Copy Name', run: () => send({ type: 'copy', text: ref.name }) });
    showMenu(e, items);
  }

  // ---------------------------------------------------------------- search
  function searchKey() { return JSON.stringify(S.query); }
  function runSearch(dir) {
    S.query = { text: q.value, mode: modeSel.value, caseSensitive: caseBtn.classList.contains('on'), regex: reBtn.classList.contains('on') };
    if (!S.query.text) { S.matches = []; S.matchSet = new Set(); S.matchIdx = -1; count.textContent = ''; render(); return; }
    if (searchKey() === S.lastSearchKey && S.matches.length) { step(dir || 1); return; }
    S.lastSearchKey = searchKey();
    S.searchId++;
    S.searching = true;
    count.textContent = 'Searching…';
    stopBtn.style.display = '';
    send({ type: 'search', id: S.searchId, query: S.query });
  }
  function step(dir) {
    if (!S.matches.length) return;
    const from = S.sel ? S.sel.i : -1;
    let k;
    if (dir > 0) { k = S.matches.findIndex(i => i > from); if (k < 0) k = 0; } else { k = -1; for (let j = S.matches.length - 1; j >= 0; j--) if (S.matches[j] < from) { k = j; break; } if (k < 0) k = S.matches.length - 1; }
    S.matchIdx = k;
    goRow(S.matches[k]);
    count.textContent = `${k + 1} of ${S.matches.length.toLocaleString()}`;
  }
  function goRow(i) {
    scrollTo(i);
    const sel = () => { if (S.cache.has(i)) { select(i, {}); return true; } return false; };
    if (!sel()) { S.pendingSelect = i; ensureRows(i - 10, i + 10); }
    render();
  }
  function searchResult(m) {
    if (m.id !== S.searchId) return;
    if (m.partial) {
      if (!m.rows.length) return;
      S.partialShown = m.id;
      S.matches = m.rows; S.matchSet = new Set(m.rows); S.matchIdx = -1;
      document.body.dataset.searchMatches = String(m.rows.length);
      step(1);
      count.textContent += ' · searching full messages…';
      return;
    }
    S.searching = false; stopBtn.style.display = 'none';
    if (m.error) { count.textContent = ''; showBanner(m.error, 'warn'); S.lastSearchKey = ''; return; }
    if (S.partialShown === m.id && S.matchIdx >= 0) {
      const cur = S.matches[S.matchIdx];
      S.matches = m.rows; S.matchSet = new Set(m.rows); S.matchIdx = Math.max(0, m.rows.indexOf(cur));
      document.body.dataset.searchMatches = String(m.rows.length);
      document.body.dataset.searchQuery = S.query.mode + ':' + S.query.text;
      count.textContent = `${S.matchIdx + 1} of ${m.rows.length.toLocaleString()}`;
      render();
      return;
    }
    S.matches = m.rows; S.matchSet = new Set(m.rows); S.matchIdx = -1;
    document.body.dataset.searchMatches = String(m.rows.length);
    document.body.dataset.searchQuery = S.query.mode + ':' + S.query.text;
    if (!m.rows.length) { count.textContent = m.notLoaded ? `0 loaded (+${m.notLoaded} older)` : 'No matches'; render(); return; }
    step(1);
    if (m.notLoaded) count.textContent += ` (+${m.notLoaded.toLocaleString()} older than the loaded history)`;
  }
  q.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runSearch(e.shiftKey ? -1 : 1); } if (e.key === 'Escape') { q.value = ''; runSearch(1); scroller.focus(); } });
  q.addEventListener('input', () => { if (!q.value) runSearch(1); });
  modeSel.addEventListener('change', () => { S.lastSearchKey = ''; q.placeholder = { text: 'Search all history (Enter)', path: 'Path or glob, e.g. src/app or *.md', content: 'Text added or removed (git log -S)', 'content-regex': 'Regex of changed lines (git log -G)' }[modeSel.value]; if (q.value) runSearch(1); });
  caseBtn.addEventListener('click', () => { caseBtn.classList.toggle('on'); S.lastSearchKey = ''; if (q.value) runSearch(1); });
  reBtn.addEventListener('click', () => { reBtn.classList.toggle('on'); S.lastSearchKey = ''; if (q.value) runSearch(1); });
  nextBtn.addEventListener('click', () => runSearch(1));
  prevBtn.addEventListener('click', () => runSearch(-1));
  stopBtn.addEventListener('click', () => { send({ type: 'cancelSearch' }); });

  // ---------------------------------------------------------------- keyboard
  scroller.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = Math.max(0, Math.min(S.total - 1, (S.sel ? S.sel.i : -1) + (e.key === 'ArrowDown' ? 1 : -1)));
      if (S.cache.has(i)) select(i, { scroll: true }); else goRow(i);
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault(); scroller.scrollTop += (e.key === 'PageDown' ? 1 : -1) * (scroller.clientHeight - H);
    } else if (e.key === 'Home') { e.preventDefault(); scroller.scrollTop = 0; }
    else if (e.key === 'End') { e.preventDefault(); scroller.scrollTop = scroller.scrollHeight; }
    else if (e.key === 'Enter' && S.sel && S.sel.row) openDetails(S.sel.row);
  });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); q.focus(); q.select(); }
    else if (e.key === 'F3') { e.preventDefault(); runSearch(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { if (menu.classList.contains('show')) hideMenu(); else if (det.classList.contains('show')) closeDetails(); }
  });

  // resizing the details pane
  resizer.addEventListener('mousedown', e => {
    e.preventDefault();
    const startY = e.clientY; const startH = det.getBoundingClientRect().height;
    const move = ev => { det.style.height = Math.max(120, Math.min(window.innerHeight - 160, startH - (ev.clientY - startY))) + 'px'; render(); };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  });

  // ---------------------------------------------------------------- toolbar
  repoSel.addEventListener('change', () => send({ type: 'pickRepo', key: repoSel.value }));
  branchBtn.addEventListener('click', () => send({ type: 'branchMenu' }));
  refreshBtn.addEventListener('click', () => send({ type: 'refresh' }));
  fetchBtn.addEventListener('click', () => act('fetch', {}));
  pullBtn.addEventListener('click', () => act('pull', {}));
  pushBtn.addEventListener('click', () => act('push', {}));
  cmpBtn.addEventListener('click', () => act('compareBranches', {}));
  saveBtn.addEventListener('click', () => send({ type: 'saveFilter' }));
  savedSel.addEventListener('change', () => { const v = savedSel.value; if (v === '__delete__') { const n = savedSel.dataset.last; if (n) send({ type: 'deleteFilter', name: n }); } else if (v) { savedSel.dataset.last = v; send({ type: 'applyFilter', name: v }); } });

  function showBanner(text, kind, buttons) {
    banner.replaceChildren();
    banner.className = 'show ' + (kind || '');
    banner.append(el('span', 'msg', text));
    for (const [label, fn] of buttons || []) banner.append(button(label, fn));
    const x = el('button', 'icon', '×'); x.title = 'Hide'; x.addEventListener('click', () => { banner.className = ''; }); banner.append(x);
  }
  function opBanner() {
    const op = S.state.operation;
    if (!op) { if (banner.dataset.op) { banner.className = ''; banner.dataset.op = ''; } return; }
    banner.dataset.op = op;
    const at = S.state.stoppedAt ? ` (stopped at ${short(S.state.stoppedAt)})` : '';
    const btns = [];
    if (op !== 'bisect') btns.push(['Continue…', () => act('opContinue', {})]);
    if (op === 'rebase' || op === 'cherry-pick' || op === 'revert' || op === 'am') btns.push(['Skip…', () => act('opSkip', {})]);
    if (op !== 'bisect') btns.push(['Abort…', () => act('opAbort', {})]);
    btns.push(['Open Source Control', () => send({ type: 'command', command: 'workbench.view.scm' })]);
    showBanner(`A ${op} is in progress${at}. Resolve conflicts in Source Control, then continue, or abort to go back.`, 'warn', btns);
  }

  function applyInit(m) {
    S.repos = m.repos; S.current = m.current; S.filter = m.filter || {}; S.saved = m.saved || []; S.pro = m.pro || []; S.dateFormat = m.dateFormat || 'locale';
    repoSel.replaceChildren();
    for (const r of m.repos) { const o = el('option', '', r.label + (r.kind === 'submodule' ? ' (submodule)' : r.bare ? ' (bare)' : '')); o.value = r.key; if (r.key === m.current) o.selected = true; repoSel.append(o); }
    repoSel.style.display = m.repos.length > 1 ? '' : 'none';
    for (const l of [tRemote, tTags, tStash, tFirst]) { const c = l.querySelector('input'); c.checked = !!S.filter[c.dataset.key]; }
    const b = S.filter.branches;
    branchBtn.textContent = !b || !b.length ? 'Branches: All' : b.length === 1 ? 'Branch: ' + b[0].replace(/^refs\/(heads|remotes)\//, '') : `Branches: ${b.length}`;
    savedSel.replaceChildren();
    const o0 = el('option', '', S.saved.length ? 'Saved filters' : 'No saved filters'); o0.value = ''; savedSel.append(o0);
    for (const f of S.saved) { const o = el('option', '', f.name); o.value = f.name; savedSel.append(o); }
    if (S.saved.length) { const od = el('option', '', 'Delete the last applied filter'); od.value = '__delete__'; savedSel.append(od); }
    saveBtn.textContent = 'Save Filter' + proMark('Saved graph filters');
    cmpBtn.textContent = 'Compare Branches' + proMark('Branch comparison report');
    const bare = !!m.bare;
    pullBtn.style.display = bare ? 'none' : ''; tStash.style.display = bare ? 'none' : '';
    if (m.shallow) stRight.textContent = 'Shallow clone: history ends where the clone was cut.';
    else stRight.textContent = '';
  }

  function reveal(hash) {
    S.req++;
    const req = 'f' + S.req;
    S.revealReq = req;
    send({ type: 'find', hash, req });
  }

  // ---------------------------------------------------------------- messages
  window.addEventListener('message', ev => {
    const m = ev.data;
    switch (m.type) {
      case 'init': applyInit(m); break;
      case 'loading':
        S.gen++; S.cache.clear(); S.inflight.clear(); S.loading = true; S.painted = false; S.loadStart = performance.now();
        S.state = m.state || S.state; opBanner();
        if (!m.keepScroll) scroller.scrollTop = 0;
        stLeft.textContent = 'Loading history…';
        if (!S.total) { emptyEl.textContent = 'Loading…'; }
        S.matches = []; S.matchSet = new Set(); S.matchIdx = -1; S.lastSearchKey = ''; if (q.value) count.textContent = 'Press Enter to search again';
        break;
      case 'refs':
        S.refs = m.refs; S.head = m.head; S.stashes = m.stashes;
        break;
      case 'progress':
        S.maxLane = Math.max(S.maxLane, m.maxLane || 0);
        setTotal(m.rows); stLeft.textContent = `Loading… ${m.rows.toLocaleString()} commits so far`;
        // blocks fetched while the tail was still growing may be short: let them load again
        S.inflight.clear();
        render();
        break;
      case 'done':
        S.loading = false; S.maxLane = m.maxLane || 0; S.loadMs = m.ms;
        if (m.empty) { setTotal(0); emptyEl.textContent = 'This repository has no commits yet.'; stLeft.textContent = ''; break; }
        setTotal(m.rows); S.inflight.clear();
        for (const k of [...S.cache.keys()]) if (k >= m.rows) S.cache.delete(k);
        stLeft.textContent = `${m.rows.toLocaleString()} rows · read in ${(m.ms / 1000).toFixed(1)} s` + (m.truncated ? ` · newest ${m.max.toLocaleString()} commits (setting zovoGit.graph.maxCommits)` : '');
        document.body.dataset.loaded = String(m.rows);
        document.body.dataset.loadMs = String(m.ms);
        if (S.pendingReveal) { const h = S.pendingReveal; S.pendingReveal = ''; reveal(h); }
        else if (S.sel && S.sel.hash) reveal(S.sel.hash);
        render();
        break;
      case 'rows': {
        S.inflight.delete(m.req);
        if (!m.req.startsWith(S.gen + ':')) break;
        for (const r of m.rows) S.cache.set(r.i, r);
        if (S.cache.size > 20000) { const { first } = visibleRange(); for (const k of S.cache.keys()) if (Math.abs(k - first) > 6000) S.cache.delete(k); }
        if (S.pendingSelect != null && S.cache.has(S.pendingSelect)) { const i = S.pendingSelect; S.pendingSelect = null; select(i, {}); }
        render();
        break;
      }
      case 'found':
        if (m.row >= 0) goRow(m.row); else if (m.req === S.revealReq) stLeft.textContent = `Commit ${short(m.hash)} is not in the loaded graph (filtered out or older).`;
        break;
      case 'details': showDetails(m); break;
      case 'compare': showCompare(m); break;
      case 'searchResult': searchResult(m); break;
      case 'searchProgress': if (m.id === S.searchId) count.textContent = `Searching… ${m.found.toLocaleString()}`; break;
      case 'error':
        S.loading = false; stLeft.textContent = '';
        showBanner(m.text, 'err', [['Refresh', () => send({ type: 'refresh' })]]);
        if (!S.total) emptyEl.textContent = 'The graph could not be loaded.';
        break;
      case 'empty': setTotal(0); emptyEl.textContent = m.text; stLeft.textContent = ''; break;
      case 'reveal': reveal(m.hash); break;
      case 'focusSearch': q.focus(); q.select(); break;
      default: break;
    }
  });

  send({ type: 'ready' });
}());
