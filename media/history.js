// File and line history list. No network, no innerHTML.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const data = JSON.parse(document.getElementById('data').textContent || '{}');
  const app = document.getElementById('app');
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const dtf = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmt = s => (data.dateFormat === 'iso' ? new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ') : dtf.format(new Date(s * 1000)));
  const head = el('h1', '', data.title);
  const sub = el('div', 'sub', 'Loading…');
  const list = el('div');
  app.append(head, sub, list);
  let count = 0;
  function patchEl(text) {
    const pre = el('pre', 'patch');
    for (const line of text.split('\n')) {
      if (/^(diff --git|index |--- |\+\+\+ )/.test(line)) continue;
      const cls = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '';
      pre.append(el('span', cls, line + '\n'));
    }
    return pre;
  }
  function item(c) {
    const d = el('div', 'item'); d.tabIndex = 0; d.setAttribute('role', 'button');
    const top = el('div', 'top');
    top.append(el('span', 's', c.subject));
    const acts = el('span', 'acts');
    const b = (t, fn, title) => { const x = el('button', '', t); x.title = title; x.addEventListener('click', e => { e.stopPropagation(); fn(); }); return x; };
    acts.append(b('Graph', () => vscode.postMessage({ type: 'graph', hash: c.hash }), 'Show this commit in the commit graph'));
    if (c.status !== 'D') acts.append(b('Open', () => vscode.postMessage({ type: 'open', hash: c.hash, path: c.path }), 'Open the file as it was at this commit'));
    acts.append(b('Copy Hash', () => vscode.postMessage({ type: 'copy', text: c.hash }), 'Copy the full hash'));
    top.append(acts);
    const meta = el('div', 'meta');
    meta.append(el('span', 'h', c.hash.slice(0, 8)), el('span', '', c.author), el('span', '', fmt(c.date)));
    if (c.status) meta.append(el('span', 'st', c.status + (c.oldPath && c.oldPath !== c.path ? ` ${c.oldPath} → ${c.path}` : '')));
    d.append(top, meta);
    if (c.patch) d.append(patchEl(c.patch));
    const open = () => vscode.postMessage({ type: 'diff', hash: c.hash, parent: c.parents[0] || '', path: c.path, oldPath: c.oldPath || c.path, status: c.status });
    d.addEventListener('click', open);
    d.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
    return d;
  }
  window.addEventListener('message', ev => {
    const m = ev.data;
    if (m.type === 'items') {
      if (!m.append) { list.replaceChildren(); count = 0; }
      const old = document.querySelector('.more'); if (old) old.remove();
      const frag = document.createDocumentFragment();
      for (const c of m.items) frag.append(item(c));
      list.append(frag);
      count += m.items.length;
      sub.textContent = count ? `${count.toLocaleString()} commit${count === 1 ? '' : 's'}${data.lines ? ' changed these lines (line numbers of the last commit)' : ', renames followed'} · ${m.ms} ms · click one for its diff` : 'No commits changed this.';
      document.body.dataset.count = String(count);
      if (m.more) { const b = el('button', 'more', 'Load more'); b.addEventListener('click', () => vscode.postMessage({ type: 'more' })); app.append(b); }
    } else if (m.type === 'error') { sub.textContent = ''; list.replaceChildren(el('div', 'msg', m.text)); document.body.dataset.count = 'error'; }
  });
  vscode.postMessage({ type: 'ready' });
}());
