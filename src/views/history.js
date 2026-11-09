'use strict';
// File history (every commit that changed a file, across renames) and line history (git log -L: how the selected
// lines changed through time). Both open in one webview with a list; a click opens the VS Code diff.
const path = require('path');
const { runGit } = require('../git/runner');
const P = require('../git/parse');
const { page } = require('./html');
const { toUri } = require('../content');

async function fileHistory(git, root, rel, { limit = 2000, skip = 0 } = {}) {
  const r = await runGit(git, ['log', '--follow', '--no-textconv', '--no-ext-diff', '-z', '--format=%x1e' + P.LOG_FORMAT, '--name-status', '-M', `--max-count=${limit}`, `--skip=${skip}`, 'HEAD', '--', rel], { cwd: root, timeoutMs: 120000, maxBytes: 64 * 1024 * 1024 });
  const out = [];
  for (const chunk of r.stdout.split('\x1e')) {
    if (!chunk) continue;
    const z = chunk.indexOf('\0');
    const c = P.parseLogRecord(z < 0 ? chunk : chunk.slice(0, z));
    if (!c) continue;
    const files = z < 0 ? [] : P.parseNameStatus(chunk.slice(z + 1).replace(/^\n/, ''));
    const f = files[0] || { status: 'M', path: rel, oldPath: rel };
    out.push({ ...c, status: f.status, path: f.path, oldPath: f.oldPath });
  }
  return out;
}

async function lineHistory(git, root, rel, start, end, { limit = 300 } = {}) {
  const r = await runGit(git, ['log', `-L${start},${end}:${rel}`, '--format=%x1e' + P.LOG_FORMAT, '--no-color', `--max-count=${limit}`, '--no-ext-diff', '--no-textconv', 'HEAD', '--'], { cwd: root, timeoutMs: 180000, maxBytes: 64 * 1024 * 1024 });
  const list = P.parseLineLog(r.stdout);
  for (const c of list) {
    if (c.patch.length > 20000) c.patch = c.patch.slice(0, 20000) + '\n… (cut at 20,000 characters)';
    const m = /^\+\+\+ b\/(.+)$/m.exec(c.patch);
    c.path = m ? m[1] : rel;
    const o = /^--- a\/(.+)$/m.exec(c.patch);
    c.oldPath = o ? o[1] : c.path;
  }
  return list;
}

function showHistory({ vscode, context, support, settings, getGit, repo, rel, lines, log, onReveal }) {
  const title = lines ? `Line History: ${path.basename(rel)}:${lines[0]}-${lines[1]}` : `File History: ${path.basename(rel)}`;
  const panel = vscode.window.createWebviewPanel('zovoGit.history', title, vscode.ViewColumn.Active, {
    enableScripts: true, retainContextWhenHidden: true, enableCommandUris: support.commandUris('zovoGit'),
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
  });
  panel.webview.html = page({ vscode, context, webview: panel.webview, script: 'history.js', css: 'history.css', title, support, settings, data: { title, rel, lines: lines || null, dateFormat: settings().dateFormat } });
  let skip = 0;
  const load = async (more) => {
    const t0 = Date.now();
    try {
      let items;
      if (lines) items = await lineHistory(getGit(), repo.root, rel, lines[0], lines[1]);
      else { items = await fileHistory(getGit(), repo.root, rel, { skip: more ? skip : 0 }); skip = (more ? skip : 0) + items.length; }
      panel.webview.postMessage({ type: 'items', items, more: !lines && items.length >= 2000, append: !!more, ms: Date.now() - t0 });
    } catch (e) {
      log(`history ${rel}: ${e.message}`);
      const text = /no such path|does not exist|unknown revision|bad revision/i.test(e.stderr || e.message) ? `${rel} has no committed history yet.` : /has only \d+ lines|file .* has only/.test(e.stderr || e.message) ? 'The selected lines are past the end of the file in the last commit. Commit the file first.' : e.message;
      panel.webview.postMessage({ type: 'error', text });
    }
  };
  panel.webview.onDidReceiveMessage(async m => {
    if (m.type === 'ready') return load(false);
    if (m.type === 'more') return load(true);
    if (m.type === 'diff') {
      const left = m.status === 'A' || !m.parent ? toUri(vscode, repo.root, '', m.oldPath) : toUri(vscode, repo.root, m.parent, m.oldPath);
      const right = m.status === 'D' ? toUri(vscode, repo.root, '', m.path) : toUri(vscode, repo.root, m.hash, m.path);
      return vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(m.path)} (${m.hash.slice(0, 8)})`, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    }
    if (m.type === 'open') return vscode.commands.executeCommand('vscode.open', toUri(vscode, repo.root, m.hash, m.path), { preview: true, viewColumn: vscode.ViewColumn.Beside });
    if (m.type === 'graph') return onReveal(repo, m.hash);
    if (m.type === 'copy') { await vscode.env.clipboard.writeText(m.text); return vscode.window.setStatusBarMessage('Copied', 2000); }
    return undefined;
  });
  return panel;
}

module.exports = { showHistory, fileHistory, lineHistory };
