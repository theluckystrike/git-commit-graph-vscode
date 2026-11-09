// Visual interactive rebase list: drag to reorder (or Alt+Up/Down), pick an action per commit. No network, no innerHTML.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const data = JSON.parse(document.getElementById('data').textContent || '{}');
  const app = document.getElementById('app');
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const items = data.commits.map(c => ({ hash: c.hash, subject: c.subject, message: c.message, author: c.author, action: 'pick', newMessage: c.message }));
  app.append(el('h1', '', `Rebase ${items.length} commit${items.length === 1 ? '' : 's'} onto ${data.base.slice(0, 8)}`));
  app.append(el('div', 'sub', 'Oldest first, as git applies them. Drag a row (or focus it and press Alt+Up / Alt+Down) to change the order. Squash and fixup join a commit into the one above it.'));
  const list = el('div', 'list');
  const bar = el('div', 'bar');
  const err = el('span', 'err', '');
  const start = el('button', 'primary', 'Start Rebase…');
  const cancel = el('button', '', 'Cancel');
  bar.append(start, cancel, err);
  app.append(list, bar);
  let dragFrom = -1;
  function check() {
    const kept = items.find(i => i.action !== 'drop');
    if (!kept) return 'Every commit is set to drop.';
    if (kept.action === 'squash' || kept.action === 'fixup') return 'The first kept commit cannot be squash or fixup.';
    return '';
  }
  function move(from, to) { if (to < 0 || to >= items.length || from === to) return; const [x] = items.splice(from, 1); items.splice(to, 0, x); render(to); }
  function render(focus) {
    list.replaceChildren();
    items.forEach((it, i) => {
      const r = el('div', 'it ' + it.action); r.draggable = true; r.tabIndex = 0; r.dataset.i = i; r.setAttribute('aria-label', `${it.action} ${it.subject}`);
      const h = el('span', 'handle', '⋮⋮'); h.title = 'Drag to move';
      const sel = el('select'); sel.setAttribute('aria-label', 'Action');
      for (const a of ['pick', 'reword', 'squash', 'fixup', 'drop']) { const o = el('option', '', a); o.value = a; if (a === it.action) o.selected = true; sel.append(o); }
      sel.addEventListener('change', () => { it.action = sel.value; render(i); });
      r.append(h, sel, el('span', 'h', it.hash.slice(0, 8)), el('span', 's', it.subject));
      if (it.action === 'reword') { const t = el('textarea'); t.value = it.newMessage; t.setAttribute('aria-label', 'New message'); t.addEventListener('input', () => { it.newMessage = t.value; }); r.append(t); }
      r.addEventListener('dragstart', e => { dragFrom = i; r.classList.add('drag'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); });
      r.addEventListener('dragend', () => { r.classList.remove('drag'); });
      r.addEventListener('dragover', e => { e.preventDefault(); r.classList.add('over'); });
      r.addEventListener('dragleave', () => r.classList.remove('over'));
      r.addEventListener('drop', e => { e.preventDefault(); r.classList.remove('over'); if (dragFrom >= 0) move(dragFrom, i); dragFrom = -1; });
      r.addEventListener('keydown', e => { if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); move(i, i + (e.key === 'ArrowUp' ? -1 : 1)); } });
      list.append(r);
    });
    err.textContent = check();
    start.disabled = !!err.textContent;
    document.body.dataset.order = items.map(i => i.hash.slice(0, 8) + ':' + i.action).join(',');
    if (focus != null && list.children[focus]) list.children[focus].focus();
  }
  start.addEventListener('click', () => vscode.postMessage({ type: 'start', items: items.map(i => ({ hash: i.hash, action: i.action, message: i.action === 'reword' ? i.newMessage : undefined })) }));
  cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  render();
}());
