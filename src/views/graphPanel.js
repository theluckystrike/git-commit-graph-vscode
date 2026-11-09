'use strict';
// The commit graph webview. The extension host relays between the webview (virtual scrolling, canvas) and the
// worker thread that owns the history of the selected repository. Commit details, diffs and actions run here.
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const { page } = require('./html');
const { toUri } = require('../content');
const details = require('../details');
const { operationFrom } = require('../git/parse');

let current = null;

class GraphPanel {
  static show(deps, repo, opts = {}) {
    if (current && !current.disposed) {
      current.panel.reveal(current.panel.viewColumn);
      if (repo && (!current.repo || current.repo.key !== repo.key)) current.setRepo(repo);
      if (opts.select) current.post({ type: 'reveal', hash: opts.select });
      return current;
    }
    current = new GraphPanel(deps, repo, opts);
    return current;
  }

  static get current() { return current && !current.disposed ? current : null; }

  constructor(deps, repo, opts) {
    this.d = deps;
    const { vscode, context, support, settings } = deps;
    this.vscode = vscode;
    this.repo = repo;
    this.t0 = Date.now();
    this.pending = new Map();
    this.seq = 0;
    this.gen = 0;
    this.stale = false;
    this.filter = this.defaultFilter();
    this.panel = vscode.window.createWebviewPanel('zovoGit.graph', this.title(), vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true, enableCommandUris: support.commandUris('zovoGit'),
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'graph-icon.svg');
    this.panel.webview.html = page({ vscode, context, webview: this.panel.webview, script: 'graph.js', css: 'graph.css', title: 'Commit Graph', support, settings, data: { initial: opts.select || '' } });
    this.subs = [];
    this.subs.push(this.panel.webview.onDidReceiveMessage(m => this.onMessage(m).catch(e => this.d.log('webview message ' + m.type + ': ' + e.stack))));
    this.subs.push(this.panel.onDidChangeViewState(() => { if (this.panel.visible && this.stale) this.reload(); }));
    this.panel.onDidDispose(() => this.dispose());
    this.watch();
  }

  title() { return this.repo ? `Commit Graph: ${this.repo.label}` : 'Commit Graph'; }

  defaultFilter() {
    const s = this.d.settings();
    return { branches: null, showRemotes: s.showRemoteBranches, showTags: s.showTags, showStash: s.showStashes, showWip: s.showUncommitted, firstParent: false, order: s.order };
  }

  post(m) { if (!this.disposed) this.panel.webview.postMessage(m); }

  watch() {
    if (this.watcher) { this.watcher.dispose(); this.watcher = null; }
    if (!this.repo) return;
    const vscode = this.vscode;
    try {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(this.repo.gitDir), '{HEAD,ORIG_HEAD,FETCH_HEAD,MERGE_HEAD,packed-refs,refs/**,logs/refs/stash,rebase-merge,rebase-apply}'));
      const fire = () => { clearTimeout(this.watchTimer); this.watchTimer = setTimeout(() => { if (this.panel.visible) this.reload(); else this.stale = true; }, 900); };
      w.onDidChange(fire); w.onDidCreate(fire); w.onDidDelete(fire);
      this.watcher = w;
    } catch (_) { /* no watcher: Refresh button */ }
  }

  setRepo(repo) {
    this.repo = repo;
    this.panel.title = this.title();
    this.filter = this.defaultFilter();
    this.watch();
    this.sendInit();
    this.reload();
  }

  repoState() {
    const g = this.repo && this.repo.gitDir;
    const op = g ? operationFrom(f => fs.existsSync(path.join(g, f))) : '';
    let stoppedAt = '';
    if (op === 'rebase') { try { stoppedAt = fs.readFileSync(path.join(g, 'rebase-merge', 'stopped-sha'), 'utf8').trim(); } catch (_) { /* none */ } }
    return { operation: op, stoppedAt };
  }

  sendInit() {
    const repos = this.d.repos();
    const s = this.d.settings();
    this.post({
      type: 'init', repos: repos.map(r => ({ key: r.key, label: r.label, kind: r.kind, bare: r.bare })), current: this.repo ? this.repo.key : '',
      filter: this.filter, saved: this.savedFilters(), pro: this.d.pro.labels(), dateFormat: s.dateFormat,
      shallow: !!(this.repo && this.repo.shallow), bare: !!(this.repo && this.repo.bare),
      missingGit: !this.d.getGit(),
    });
  }

  savedFilters() {
    if (!this.repo) return [];
    return (this.d.context.workspaceState.get('zovoGit.savedFilters', {})[this.repo.key]) || [];
  }

  async saveFilters(list) {
    const all = this.d.context.workspaceState.get('zovoGit.savedFilters', {});
    all[this.repo.key] = list;
    await this.d.context.workspaceState.update('zovoGit.savedFilters', all);
  }

  startWorker() {
    if (this.worker) { try { this.worker.terminate(); } catch (_) { /* gone */ } }
    this.worker = null;
    if (!this.repo || !this.d.getGit()) return null;
    const w = new Worker(path.join(__dirname, '..', 'graph', 'worker.js'), { workerData: { git: this.d.getGit(), cwd: this.repo.root }, resourceLimits: { maxOldGenerationSizeMb: 2048 } });
    w.on('message', m => this.onWorker(w, m));
    w.on('error', e => { this.d.log('graph worker: ' + e.message); this.post({ type: 'error', text: 'The graph worker stopped: ' + e.message }); });
    this.worker = w;
    this.workerRepo = this.repo.key;
    return w;
  }

  reload(keepScroll = true) {
    this.stale = false;
    if (!this.repo) { this.post({ type: 'empty', text: 'No git repository in this workspace. Open a folder that contains one.' }); return; }
    if (!this.d.getGit()) { this.post({ type: 'empty', text: 'git was not found. Install git, or set zovoGit.path to the git program.' }); return; }
    const w = (this.worker && this.workerRepo === this.repo.key) ? this.worker : this.startWorker();
    const s = this.d.settings();
    this.loadT0 = Date.now();
    this.firstPainted = false;
    this.gen++;
    this.post({ type: 'loading', gen: this.gen, keepScroll, state: this.repoState() });
    w.postMessage({ type: 'load', opts: { ...this.filter, bare: this.repo.bare, maxCommits: s.maxCommits, statusTimeoutMs: s.statusTimeoutSec * 1000 } });
  }

  onWorker(w, m) {
    if (w !== this.worker) return;
    if (m.type === 'rows' || m.type === 'found' || m.type === 'stats' || m.type === 'fail') {
      const p = this.pending.get(m.id);
      if (p) { this.pending.delete(m.id); p(m); }
      return;
    }
    if (m.type === 'refs') this.refs = m.refs;
    if (m.type === 'reloadNeeded') { this.d.log(`graph ${this.repo.label}: git status finished late, reloading to show the uncommitted changes`); this.reload(); return; }
    if (m.type === 'done') {
      this.d.log(`graph ${this.repo.label}: ${m.rows} rows in ${m.ms} ms${m.truncated ? ` (first ${m.max})` : ''}, about ${Math.round((m.bytes || 0) / 1048576)} MB`);
      if (!m.empty) this.d.rating.success(this.d.vscode.Uri.file(this.repo.root));
    }
    if (m.type === 'error') {
      this.d.log(`graph ${this.repo.label}: ${m.text}\n${m.stderr || ''}`);
      this.d.rating.failure();
      m.text = explainLoadError(m.text, m.stderr);
    }
    this.post(m);
  }

  ask(msg) {
    return new Promise(resolve => {
      if (!this.worker) return resolve(null);
      const id = ++this.seq;
      this.pending.set(id, resolve);
      this.worker.postMessage({ ...msg, id });
    });
  }

  git() { return this.d.getGit(); }

  async onMessage(m) {
    const vscode = this.vscode;
    const repo = this.repo;
    const A = this.d.actions;
    switch (m.type) {
      case 'ready': this.sendInit(); this.reload(false); return;
      case 'rows': {
        const r = await this.ask({ type: 'rows', start: m.start, end: m.end });
        if (r) this.post({ type: 'rows', req: m.req, start: r.start, rows: r.rows, total: r.total, loading: r.loading });
        return;
      }
      case 'painted':
        if (!this.firstPainted) { this.firstPainted = true; this.d.log(`graph ${repo && repo.label}: first rows on screen ${Date.now() - this.loadT0} ms after load start (${m.rows} rows loaded so far)`); }
        return;
      case 'find': { const r = await this.ask({ type: 'find', hash: m.hash }); this.post({ type: 'found', req: m.req, row: r ? r.row : -1, hash: m.hash }); return; }
      case 'search': if (this.worker) this.worker.postMessage({ type: 'search', id: m.id, query: m.query }); return;
      case 'cancelSearch': if (this.worker) this.worker.postMessage({ type: 'cancelSearch' }); return;
      case 'refresh': this.reload(); return;
      case 'pickRepo': { const r = this.d.repos().find(x => x.key === m.key); if (r) this.setRepo(r); return; }
      case 'filter': this.filter = { ...this.filter, ...m.filter }; this.reload(false); return;
      case 'saveFilter': {
        if (!(await this.d.pro.allow('Saved graph filters', 'Save a branch filter and switch to it in one click.'))) return;
        const name = await vscode.window.showInputBox({ title: 'Save this filter as', prompt: 'Name for the current branch filter and view options', ignoreFocusOut: true, validateInput: v => (v.trim() ? null : 'Type a name.') });
        if (!name) return;
        const list = this.savedFilters().filter(f => f.name !== name.trim());
        list.push({ name: name.trim(), filter: this.filter });
        await this.saveFilters(list); this.sendInit(); return;
      }
      case 'applyFilter': { const f = this.savedFilters().find(x => x.name === m.name); if (f) { if (!(await this.d.pro.allow('Saved graph filters', 'Switch to a saved filter.'))) return; this.filter = { ...this.defaultFilter(), ...f.filter }; this.sendInit(); this.reload(false); } return; }
      case 'deleteFilter': await this.saveFilters(this.savedFilters().filter(f => f.name !== m.name)); this.sendInit(); return;
      case 'details': return this.sendDetails(m);
      case 'compare': return this.sendCompare(m);
      case 'openDiff': return this.openDiff(m);
      case 'openFile': return this.openFile(m);
      case 'openWorking': { const u = vscode.Uri.file(path.join(repo.root, m.path)); return vscode.commands.executeCommand('vscode.open', u, { preview: true, viewColumn: vscode.ViewColumn.Beside }); }
      case 'fileHistory': return vscode.commands.executeCommand('zovoGit.fileHistory', vscode.Uri.file(path.join(repo.root, m.path)));
      case 'copy': await vscode.env.clipboard.writeText(String(m.text)); vscode.window.setStatusBarMessage('Copied', 2000); return;
      case 'branchMenu': return this.d.branchPicker(this);
      case 'command': return vscode.commands.executeCommand(m.command, ...(m.args || []));
      case 'action': return this.runAction(m);
      default: return undefined;
    }
  }

  async sendDetails(m) {
    const s = this.d.settings();
    try {
      let data;
      if (m.kind === 'wip') data = await details.workingTreeDetails(this.git(), this.repo.root, { maxFiles: s.maxFilesInDetails });
      else if (m.kind === 'stash') data = await details.stashDetails(this.git(), this.repo.root, m.hash, { maxFiles: s.maxFilesInDetails });
      else data = await details.commitDetails(this.git(), this.repo.root, m.hash, { maxFiles: s.maxFilesInDetails, parent: m.parent });
      this.post({ type: 'details', req: m.req, hash: m.hash, kind: m.kind, data });
    } catch (e) {
      this.post({ type: 'details', req: m.req, hash: m.hash, kind: m.kind, error: explainLoadError(e.message, e.stderr) });
    }
  }

  async sendCompare(m) {
    try {
      const s = this.d.settings();
      const data = await details.filesBetween(this.git(), this.repo.root, m.a, m.b === 'WORKTREE' ? null : m.b, { maxFiles: s.maxFilesInDetails });
      this.post({ type: 'compare', req: m.req, a: m.a, b: m.b, data });
    } catch (e) {
      this.post({ type: 'compare', req: m.req, a: m.a, b: m.b, error: explainLoadError(e.message, e.stderr) });
    }
  }

  openDiff(m) {
    const vscode = this.vscode;
    const root = this.repo.root;
    const left = m.status === 'A' || m.status === 'U' || !m.a ? toUri(vscode, root, '', m.oldPath || m.path) : toUri(vscode, root, m.a, m.oldPath || m.path);
    let right;
    if (m.b === 'WORKTREE') right = m.status === 'D' ? toUri(vscode, root, '', m.path) : vscode.Uri.file(path.join(root, m.path));
    else right = m.status === 'D' ? toUri(vscode, root, '', m.path) : toUri(vscode, root, m.b, m.path);
    const name = path.basename(m.path);
    const sa = m.a ? m.a.slice(0, 8) : 'empty';
    const sb = m.b === 'WORKTREE' ? 'working tree' : m.b.slice(0, 8);
    return vscode.commands.executeCommand('vscode.diff', left, right, `${name} (${sa} ↔ ${sb})`, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  }

  openFile(m) {
    const vscode = this.vscode;
    return vscode.commands.executeCommand('vscode.open', toUri(vscode, this.repo.root, m.ref, m.path), { preview: true, viewColumn: vscode.ViewColumn.Beside });
  }

  async runAction(m) {
    const A = this.d.actions;
    const repo = this.repo;
    const st = m.state || {};
    switch (m.name) {
      case 'checkout': return A.checkoutBranch(repo, m.ref);
      case 'checkoutRemote': return A.checkoutRemote(repo, m.ref, m.branch, !!m.localExists);
      case 'checkoutCommit': return A.checkoutCommit(repo, m.hash);
      case 'createBranch': return A.createBranch(repo, m.hash);
      case 'deleteBranch': return A.deleteBranch(repo, m.ref);
      case 'deleteRemoteBranch': return A.deleteRemoteBranch(repo, m.remote, m.branch);
      case 'renameBranch': return A.renameBranch(repo, m.ref);
      case 'createTag': return A.createTag(repo, m.hash);
      case 'deleteTag': return A.deleteTag(repo, m.ref);
      case 'pushTag': return A.pushTag(repo, m.ref, st.remotes);
      case 'merge': return A.merge(repo, m.ref, st.branch);
      case 'rebase': return A.rebaseOnto(repo, m.ref, st.branch);
      case 'cherryPick': return A.cherryPick(repo, m.hash, !!m.isMerge);
      case 'revert': return A.revert(repo, m.hash, !!m.isMerge);
      case 'reset': return A.reset(repo, m.hash, st.branch);
      case 'squash': return A.squash(repo, m.a, m.b, this.repoState().operation);
      case 'interactiveRebase': return this.vscode.commands.executeCommand('zovoGit.interactiveRebase', { repo: repo.key, base: m.hash });
      case 'compareBranches': return this.vscode.commands.executeCommand('zovoGit.compareBranches', { repo: repo.key, a: m.a, b: m.b });
      case 'stashApply': return A.stashApply(repo, m.ref);
      case 'stashPop': return A.stashPop(repo, m.ref);
      case 'stashDrop': return A.stashDrop(repo, m.ref);
      case 'stashPush': return A.stashPush(repo);
      case 'fetch': return A.gitFetch(repo, true);
      case 'pull': return A.pull(repo, st.branch);
      case 'push': return A.push(repo, st.branch, st.upstream, st.remotes);
      case 'opContinue': return A.operation(repo, this.repoState().operation, 'continue');
      case 'opAbort': return A.operation(repo, this.repoState().operation, 'abort');
      case 'opSkip': return A.operation(repo, this.repoState().operation, 'skip');
      default: return undefined;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.worker) { try { this.worker.terminate(); } catch (_) { /* gone */ } }
    if (this.watcher) this.watcher.dispose();
    clearTimeout(this.watchTimer);
    for (const s of this.subs) s.dispose();
    if (current === this) current = null;
    try { this.panel.dispose(); } catch (_) { /* already */ }
  }
}

function explainLoadError(text, stderr) {
  const s = `${text}\n${stderr || ''}`;
  if (/dubious ownership|safe\.directory/.test(s)) return 'git does not trust this folder because another user owns it (safe.directory). Run the git config command git prints, in a terminal, if you trust it.';
  if (/packfile .* (does not match|cannot be accessed)|bad object|corrupt|inflate|unable to read|object file .* is empty|loose object .* is corrupt|invalid index-pack|did not receive expected object/i.test(s)) {
    return 'git could not read part of this repository: it looks damaged. Commit Graph only reads, so nothing was changed. Try git fsck in a terminal.\n\n' + text;
  }
  if (/promisor|lazy fetch/i.test(s)) return 'This is a partial clone and the object is not on this computer. Commit Graph never downloads anything.\n\n' + text;
  if (/not a git repository/i.test(s)) return 'This folder is not a git repository any more.';
  return text;
}

module.exports = { GraphPanel, explainLoadError };
