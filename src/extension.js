'use strict';
const vscode = require('vscode');
const path = require('path');
const { findGit } = require('./git/runner');
const repos = require('./repos');
const { GraphPanel } = require('./views/graphPanel');
const { showHistory } = require('./views/history');
const { openRebaseEditor } = require('./views/rebaseEditor');
const { createContentProvider, SCHEME } = require('./content');
const { Actions } = require('./actions');
const { compareBranches, reportMarkdown } = require('./compareReport');
const { createRatingPrompt } = require('./rate');
const support = require('./support');
const { createPro } = require('./pro');

const EXT_ID = 'zovo.zovo-git-commit-graph';

let cached = null;
function settings() {
  if (cached) return cached;
  const c = vscode.workspace.getConfiguration('zovoGit');
  const num = (k, d, lo, hi) => { const v = Number(c.get(k, d)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  const df = c.get('dateFormat', 'locale');
  cached = {
    path: String(c.get('path', '') || '').trim(),
    order: c.get('graph.order', 'date') === 'topo' ? 'topo' : 'date',
    maxCommits: num('graph.maxCommits', 500000, 1000, 5000000),
    showRemoteBranches: c.get('graph.showRemoteBranches', true) !== false,
    showTags: c.get('graph.showTags', true) !== false,
    showStashes: c.get('graph.showStashes', true) !== false,
    showUncommitted: c.get('graph.showUncommittedChanges', true) !== false,
    dateFormat: ['locale', 'iso', 'relative'].includes(df) ? df : 'locale',
    maxFileMB: num('maxFileMB', 50, 1, 2048),
    maxFilesInDetails: num('maxFilesInDetails', 5000, 100, 100000),
    detectDepth: num('detectDepth', 2, 0, 6),
    statusTimeoutSec: num('statusTimeoutSec', 15, 2, 600),
    showStatusBar: c.get('showStatusBarItem', true) !== false,
    showSupportLinks: c.get('showSupportLinks', true) !== false,
  };
  return cached;
}

let output;
const log = line => { if (output) output.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${line}`); };

const state = { git: null, repos: [], scanning: null, problems: [] };
let rating = { success() {}, failure() {} };
let pro;
let actions;
let statusItem;

async function locateGit() {
  let fromVsCode = '';
  try {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (ext && ext.isActive && ext.exports && ext.exports.enabled !== false) fromVsCode = ext.exports.getAPI(1).git.path || '';
  } catch (_) { /* git extension off */ }
  const found = await findGit(settings().path, fromVsCode);
  state.git = found ? found.path : null;
  log(found ? `git ${found.version} at ${found.path}` : 'git not found');
  return state.git;
}

function scan() {
  if (!state.scanning) {
    state.scanning = (async () => {
      if (!state.git) await locateGit();
      const folders = (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
      if (!state.git || !folders.length) { state.repos = []; return state.repos; }
      const r = await repos.discover(state.git, folders, { depth: settings().detectDepth, log });
      state.repos = r.repos;
      state.problems = r.problems;
      for (const p of r.problems) log(`skipped ${p.folder}: ${p.message}`);
      vscode.commands.executeCommand('setContext', 'zovoGit.hasRepo', state.repos.length > 0);
      state.scanned = true;
      updateStatus();
      return state.repos;
    })().finally(() => { setTimeout(() => { state.scanning = null; }, 0); });
  }
  return state.scanning;
}

function updateStatus() {
  if (!statusItem) return;
  if (state.repos.length && settings().showStatusBar) statusItem.show(); else statusItem.hide();
}

async function pickRepo(hint) {
  if (!state.scanned || !state.repos.length) await scan(); else if (state.scanning) await state.scanning;
  if (!state.git) {
    const pick = await vscode.window.showErrorMessage('git was not found. Install git, or set zovoGit.path to the git program.', 'Open Settings');
    if (pick) vscode.commands.executeCommand('workbench.action.openSettings', 'zovoGit.path');
    return null;
  }
  if (!state.repos.length) {
    const p = state.problems[0];
    vscode.window.showInformationMessage(p ? `git does not trust ${p.folder} (safe.directory): ${p.message}` : 'No git repository was found in this workspace. Open a folder that contains one.');
    return null;
  }
  if (hint) {
    const file = hint.fsPath || hint;
    const r = repos.repoFor(state.repos, file) || state.repos.find(x => x.key === hint);
    if (r) return r;
  }
  if (state.repos.length === 1) return state.repos[0];
  // several repositories: the one of the active file, else the first workspace folder's own. The graph's toolbar
  // switches to the others (nested repositories and submodules).
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.uri.scheme === 'file') { const r = repos.repoFor(state.repos, ed.document.uri.fsPath); if (r) return r; }
  return state.repos.find(r => r.kind === 'folder') || state.repos[0];
}

function deps() {
  return { vscode, context: ctx, support, settings, log, rating, pro, actions, getGit: () => state.git, repos: () => state.repos, branchPicker };
}

async function showGraph(arg, select) {
  let hint = null;
  if (arg && arg.rootUri) hint = arg.rootUri; // Source Control title button
  else if (arg instanceof vscode.Uri) hint = arg;
  else if (arg && typeof arg.repo === 'string') hint = arg.repo;
  const repo = await pickRepo(hint);
  if (!repo) return null;
  return GraphPanel.show(deps(), repo, { select });
}

async function branchPicker(panel) {
  const refs = panel.refs;
  if (!refs) return;
  const cur = panel.filter.branches || [];
  const items = [{ label: 'All branches', id: '__all__', picked: !cur.length }];
  items.push({ label: 'Local branches', kind: vscode.QuickPickItemKind.Separator });
  for (const h of refs.heads) items.push({ label: h.name, description: h.current ? 'checked out' : h.upstream ? '→ ' + h.upstream : '', id: 'refs/heads/' + h.name, picked: cur.includes('refs/heads/' + h.name) });
  if (refs.remotes.length) items.push({ label: 'Remote branches', kind: vscode.QuickPickItemKind.Separator });
  for (const r of refs.remotes) items.push({ label: r.name, id: 'refs/remotes/' + r.name, picked: cur.includes('refs/remotes/' + r.name) });
  if (refs.tags.length && refs.tags.length <= 500) items.push({ label: 'Tags', kind: vscode.QuickPickItemKind.Separator });
  if (refs.tags.length <= 500) for (const t of refs.tags) items.push({ label: t.name, id: 'refs/tags/' + t.name, picked: cur.includes('refs/tags/' + t.name) });
  const picked = await vscode.window.showQuickPick(items, { canPickMany: true, title: 'Branches to show (none or "All branches" shows every branch)', matchOnDescription: true });
  if (!picked) return;
  const ids = picked.map(p => p.id).filter(Boolean);
  const branches = !ids.length || ids.includes('__all__') ? null : ids;
  panel.filter = { ...panel.filter, branches };
  panel.sendInit();
  panel.reload(false);
}

function relPath(repo, uri) { return path.relative(repo.root, uri.fsPath).split(path.sep).join('/'); }

async function fileHistory(uri) {
  const target = uri instanceof vscode.Uri ? uri : (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
  if (!target || target.scheme !== 'file') { vscode.window.showInformationMessage('Open a file from a git repository first.'); return null; }
  const repo = await pickRepo(target);
  if (!repo) return null;
  return showHistory({ vscode, context: ctx, support, settings, getGit: () => state.git, repo, rel: relPath(repo, target), log, onReveal: (r, h) => GraphPanel.show(deps(), r, { select: h }) });
}

async function lineHistory() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.uri.scheme !== 'file') { vscode.window.showInformationMessage('Select lines in a file from a git repository first.'); return null; }
  const repo = await pickRepo(ed.document.uri);
  if (!repo) return null;
  const s = ed.selection;
  const start = s.start.line + 1;
  let end = s.end.line + 1;
  if (s.end.character === 0 && end > start) end--;
  return showHistory({ vscode, context: ctx, support, settings, getGit: () => state.git, repo, rel: relPath(repo, ed.document.uri), lines: [start, end], log, onReveal: (r, h) => GraphPanel.show(deps(), r, { select: h }) });
}

async function refList(repo) {
  const { runGit } = require('./git/runner');
  const P = require('./git/parse');
  const r = await runGit(state.git, ['for-each-ref', '--format=' + P.REF_FORMAT, 'refs/heads', 'refs/remotes', 'refs/tags'], { cwd: repo.root });
  return P.parseRefs(r.stdout);
}

async function compareBranchesCmd(arg) {
  const repo = await pickRepo(arg && arg.repo);
  if (!repo) return null;
  if (!(await pro.allow('Branch comparison report', 'A report of the commits, files and authors between two branches.'))) return null;
  let a = arg && arg.a; let b = arg && arg.b;
  if (!a || !b) {
    const refs = await refList(repo);
    const names = [...refs.heads.map(h => ({ label: h.name, description: h.current ? 'checked out' : '' })), ...refs.remotes.map(r => ({ label: r.name, description: 'remote' })), ...refs.tags.slice(0, 300).map(t => ({ label: t.name, description: 'tag' }))];
    const pa = await vscode.window.showQuickPick(names, { title: 'Compare branches: base (for example main)' });
    if (!pa) return null;
    const pb = await vscode.window.showQuickPick(names.filter(n => n.label !== pa.label), { title: `Compare branches: compare with ${pa.label}` });
    if (!pb) return null;
    a = pa.label; b = pb.label;
  }
  try {
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Comparing ${b} with ${a}` }, () => compareBranches(state.git, repo.root, a, b));
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: reportMarkdown(r) });
    await vscode.window.showTextDocument(doc, { preview: false });
    return doc;
  } catch (e) {
    vscode.window.showErrorMessage(`Could not compare ${b} with ${a}: ${e.message}`);
    return null;
  }
}

async function interactiveRebaseCmd(arg) {
  const repo = await pickRepo(arg && arg.repo);
  if (!repo) return null;
  if (!(await pro.allow('Interactive rebase editor', 'Reorder, reword, squash and drop commits with drag and drop.'))) return null;
  let base = arg && arg.base;
  if (!base) {
    const v = await vscode.window.showInputBox({ title: 'Interactive rebase: base commit', prompt: 'Commits after this one can be reordered, reworded, squashed or dropped (for example HEAD~5 or a hash)', value: 'HEAD~5', ignoreFocusOut: true });
    if (!v) return null;
    try {
      const { runGit } = require('./git/runner');
      base = (await runGit(state.git, ['rev-parse', '--verify', v.trim() + '^{commit}'], { cwd: repo.root })).stdout.trim();
    } catch (e) { vscode.window.showWarningMessage(`${v} is not a commit here.`); return null; }
  }
  const op = GraphPanel.current && GraphPanel.current.repo && GraphPanel.current.repo.key === repo.key ? GraphPanel.current.repoState().operation : '';
  return openRebaseEditor({ vscode, context: ctx, support, settings, getGit: () => state.git, repo, base, actions, operation: op });
}

async function goToCommit() {
  const repo = await pickRepo();
  if (!repo) return null;
  const v = await vscode.window.showInputBox({ title: 'Go to commit', prompt: 'Hash, branch, tag or any revision (HEAD~3)', ignoreFocusOut: true });
  if (!v) return null;
  try {
    const { runGit } = require('./git/runner');
    const h = (await runGit(state.git, ['rev-parse', '--verify', v.trim() + '^{commit}'], { cwd: repo.root })).stdout.trim();
    return GraphPanel.show(deps(), repo, { select: h });
  } catch (e) { vscode.window.showWarningMessage(`${v} is not a commit in ${repo.label}.`); return null; }
}

let ctx;
function activate(context) {
  ctx = context;
  output = vscode.window.createOutputChannel('Commit Graph');
  context.subscriptions.push(output);
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: 'zovoGit', name: 'Commit Graph' });
  support.registerSupport({ vscode, context, prefix: 'zovoGit', selfId: EXT_ID });
  pro = createPro({ vscode, context });
  actions = new Actions({ vscode, getGit: () => state.git, log, onChanged: () => { const p = GraphPanel.current; if (p) setTimeout(() => p.reload(), 150); } });

  const provider = createContentProvider({ vscode, getGit: () => state.git, settings, log });
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider));

  statusItem = vscode.window.createStatusBarItem ? vscode.window.createStatusBarItem(vscode.StatusBarAlignment ? vscode.StatusBarAlignment.Left : 1, 90) : null;
  if (statusItem) {
    statusItem.text = '$(git-commit) Graph';
    statusItem.tooltip = 'Open the commit graph (branches, history, search)';
    statusItem.command = 'zovoGit.showGraph';
    context.subscriptions.push(statusItem);
  }

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('zovoGit.showGraph', (arg) => showGraph(arg));
  reg('zovoGit.fileHistory', fileHistory);
  reg('zovoGit.lineHistory', lineHistory);
  reg('zovoGit.compareBranches', compareBranchesCmd);
  reg('zovoGit.interactiveRebase', interactiveRebaseCmd);
  reg('zovoGit.goToCommit', goToCommit);
  reg('zovoGit.searchHistory', async () => { const p = await showGraph(); if (p) p.post({ type: 'focusSearch' }); });
  reg('zovoGit.refreshRepositories', async () => { state.git = null; await scan(); vscode.window.setStatusBarMessage(`Commit Graph: ${state.repos.length} repositor${state.repos.length === 1 ? 'y' : 'ies'}`, 3000); });
  reg('zovoGit.showOutput', () => output.show(true));

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('zovoGit')) { cached = null; updateStatus(); if (e.affectsConfiguration('zovoGit.path')) { state.git = null; scan(); } }
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => scan()));
  // finds repositories in the background: git rev-parse only, hooks off
  scan().catch(e => log('scan: ' + e.message));
}

function deactivate() {
  const p = GraphPanel.current;
  if (p) p.dispose();
}

module.exports = { activate, deactivate, settings };
