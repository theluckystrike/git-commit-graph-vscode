'use strict';
// Visual interactive rebase (Pro candidate): the commits after a base, oldest first. Drag to reorder, choose pick,
// reword, squash, fixup or drop, then Start shows the exact command and todo list before git runs it.
const rebase = require('../rebase');
const { page } = require('./html');

async function inspectBase(git, cwd, base, operation) {
  if (operation) return { ok: false, reason: `A ${operation} is in progress. Finish or abort it first.` };
  if (!(await rebase.isAncestor(git, cwd, base, 'HEAD'))) return { ok: false, reason: 'The commit must be in the history of the checked-out branch.' };
  if (!(await rebase.cleanTree(git, cwd))) return { ok: false, reason: 'You have uncommitted changes to tracked files. Commit or stash them first.' };
  const commits = await rebase.commitsSince(git, cwd, base);
  if (!commits.length) return { ok: false, reason: 'There are no commits after this one on the current branch.' };
  if (commits.some(c => c.parents.length > 1)) return { ok: false, reason: 'There are merge commits after this one. The visual rebase works on a straight line of commits.' };
  if (commits.length > 1000) return { ok: false, reason: `There are ${commits.length} commits after this one. Pick a newer base (at most 1,000 commits).` };
  return { ok: true, commits };
}

/** Checks a plan from the webview against the commits; returns an error text or ''. */
function validatePlan(items, commits) {
  if (!Array.isArray(items) || items.length !== commits.length) return 'The list does not match the commits any more. Reopen the editor.';
  const want = new Set(commits.map(c => c.hash));
  const seen = new Set();
  for (const it of items) {
    if (!want.has(it.hash) || seen.has(it.hash)) return 'The list does not match the commits any more. Reopen the editor.';
    seen.add(it.hash);
    if (!rebase.ACTIONS.includes(it.action)) return 'Unknown action ' + it.action;
  }
  const firstKept = items.find(i => i.action !== 'drop');
  if (!firstKept) return 'Every commit is set to drop. Keep at least one, or use Reset instead.';
  if (firstKept.action === 'squash' || firstKept.action === 'fixup') return 'The first kept commit cannot be squash or fixup: there is no commit above it to join.';
  return '';
}

function openRebaseEditor({ vscode, context, support, settings, getGit, repo, base, actions, operation }) {
  return (async () => {
    const ins = await inspectBase(getGit(), repo.root, base, operation);
    if (!ins.ok) { vscode.window.showWarningMessage('Interactive rebase: ' + ins.reason); return null; }
    const panel = vscode.window.createWebviewPanel('zovoGit.rebase', `Interactive Rebase: ${ins.commits.length} commits`, vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true, enableCommandUris: support.commandUris('zovoGit'),
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    const data = { base, commits: ins.commits.map(c => ({ hash: c.hash, subject: c.subject, message: c.message, author: c.author })) };
    panel.webview.html = page({ vscode, context, webview: panel.webview, script: 'rebase.js', css: 'rebase.css', title: 'Interactive rebase', support, settings, data });
    panel.webview.onDidReceiveMessage(async m => {
      if (m.type === 'cancel') return panel.dispose();
      if (m.type !== 'start') return undefined;
      const err = validatePlan(m.items, ins.commits);
      if (err) { vscode.window.showWarningMessage(err); return undefined; }
      const byHash = new Map(ins.commits.map(c => [c.hash, c]));
      const items = m.items.map(i => ({ hash: i.hash, action: i.action, message: byHash.get(i.hash).message, newMessage: i.action === 'reword' && typeof i.message === 'string' && i.message.trim() ? i.message : undefined }));
      for (const it of items) if (it.action === 'reword' && it.newMessage === undefined) it.action = 'pick';
      const { lines } = rebase.todoLines(items, i => `<message file ${i + 1}>`);
      const ok = await actions.confirm(`Rebase ${items.length} commits?`, rebase.describe(base.slice(0, 8), lines), { button: 'Start Rebase', warning: 'This rewrites the commits after the base. If they are pushed, others who use them will have to rebase too. The old commits stay in the reflog for a while.' });
      if (!ok) return undefined;
      const done = await actions.runPlan(repo, base, items, `Rebasing ${items.length} commits`, ins.commits.map(c => c.hash));
      if (done) panel.dispose();
      return undefined;
    });
    return panel;
  })();
}

module.exports = { openRebaseEditor, validatePlan, inspectBase };
